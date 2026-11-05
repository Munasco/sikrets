#!/bin/bash
# Provisions the hosted demo in us-east-1: an IAM role that can only read the access code and the
# model key's ciphertext and send a heartbeat, a KMS key only the enclave image can decrypt with, a
# Graviton instance with Nitro Enclaves enabled (SSM-managed, no SSH, IMDSv2 only) reachable only
# from CloudFront, a CloudFront distribution for HTTPS, and alarms and a monthly budget that alert an
# SNS topic. Safe to re-run: existing pieces are reused. Prints IDs and the URL, never a secret.
#
#   GEMINI_API_KEY=…    store or replace the model key (encrypted under the KMS key; MODEL.keyEnv)
#   ENCLAVE_PCR0=…      pin the KMS key to this enclave build (host.sh build prints it); during a
#                       switch, "<old>,<new>" lets both decrypt, then pin the new one alone
#   DEPLOY_REF=…        tag or commit SHA a new instance deploys; required to create one
#   ALERT_EMAIL=…       subscribe this address to the alerts topic (AWS emails a confirmation)
set -euo pipefail
export AWS_REGION=us-east-1 AWS_PAGER=""
NAME=sikrets-agent-demo
TAGS="Key=Project,Value=$NAME"
HERE=$(cd "$(dirname "$0")" && pwd)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
TYPE=${INSTANCE_TYPE:-c7g.xlarge}
REPO=https://github.com/Munasco/sikrets.git
KEY_ALIAS=alias/$NAME
# Must match KEY_CONTEXT in deploy/enclave/bootstrap.py.
KEY_CONTEXT=app=$NAME,secret=model-key
METRICS=Sikrets/AgentDemo
BUDGET_USD=${BUDGET_USD:-150}

# --- Access code: generated once, kept in SSM (SecureString) and the operator's macOS keychain.
if ! aws ssm get-parameter --name /$NAME/access-code >/dev/null 2>&1; then
  code=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)
  aws ssm put-parameter --name /$NAME/access-code --type SecureString --value "$code" --tags $TAGS >/dev/null
  if command -v security >/dev/null; then
    security add-generic-password -U -s $NAME -a access-code -w "$code"
  fi
  unset code
  echo "access code: stored (keychain service $NAME)"
fi

# --- IAM role: read the access code and the key's ciphertext, send the heartbeat. Nothing else:
# no SSM parameter by wildcard, and no KMS permission (the key policy below grants Decrypt to this
# role only with the enclave's attestation).
if ! aws iam get-role --role-name $NAME >/dev/null 2>&1; then
  aws iam create-role --role-name $NAME --tags $TAGS --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name $NAME --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
fi
aws iam put-role-policy --role-name $NAME --policy-name agent --policy-document "$(cat <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":"ssm:GetParameter","Resource":["arn:aws:ssm:us-east-1:$ACCOUNT:parameter/$NAME/access-code","arn:aws:ssm:us-east-1:$ACCOUNT:parameter/$NAME/model-key-ciphertext"]},
 {"Effect":"Allow","Action":"cloudwatch:PutMetricData","Resource":"*","Condition":{"StringEquals":{"cloudwatch:namespace":"$METRICS"}}}
]}
EOF
)"
if ! aws iam get-instance-profile --instance-profile-name $NAME >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name $NAME --tags $TAGS >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name $NAME --role-name $NAME
  sleep 10 # instance profiles take a moment to be usable
fi

# --- KMS key for the model key. The account can manage it and encrypt with it, but nobody can
# decrypt, re-encrypt or grant: the only Decrypt is the instance role's, and only with an attestation
# document whose PCR0 (ImageSha384) is the enclave build pinned here. KMS then returns the key
# encrypted to the enclave, so the host relaying the call never sees it. Until a build is pinned
# (ENCLAVE_PCR0), nothing can decrypt.
key_policy() {
  cat <<EOF
{"Version":"2012-10-17","Statement":[
 {"Sid":"Manage","Effect":"Allow","Principal":{"AWS":"arn:aws:iam::$ACCOUNT:root"},"Resource":"*","Action":[
   "kms:DescribeKey","kms:GetKeyPolicy","kms:PutKeyPolicy","kms:GetKeyRotationStatus","kms:EnableKeyRotation","kms:DisableKeyRotation",
   "kms:ListResourceTags","kms:TagResource","kms:UntagResource","kms:ListGrants","kms:RevokeGrant","kms:CreateAlias","kms:UpdateAlias","kms:DeleteAlias",
   "kms:UpdateKeyDescription","kms:EnableKey","kms:DisableKey","kms:ScheduleKeyDeletion","kms:CancelKeyDeletion","kms:Encrypt"]},
 {"Sid":"EnclaveDecrypt","Effect":"Allow","Principal":{"AWS":"arn:aws:iam::$ACCOUNT:role/$NAME"},"Action":"kms:Decrypt","Resource":"*",
  "Condition":{"StringEqualsIgnoreCase":{"kms:RecipientAttestation:ImageSha384":[$(echo "$1" | sed 's/[^,][^,]*/"&"/g')]}}}
]}
EOF
}
KEY=$(aws kms describe-key --key-id $KEY_ALIAS --query KeyMetadata.KeyId --output text 2>/dev/null || true)
if [ -z "$KEY" ]; then
  KEY=$(aws kms create-key --description "$NAME model key: decrypts only inside the attested enclave" --tags TagKey=Project,TagValue=$NAME \
    --policy "$(key_policy "$(printf '0%.0s' {1..96})")" --query KeyMetadata.KeyId --output text)
  aws kms create-alias --alias-name $KEY_ALIAS --target-key-id "$KEY"
  aws kms enable-key-rotation --key-id "$KEY"
fi
if [ -n "${ENCLAVE_PCR0:-}" ]; then
  [[ "$ENCLAVE_PCR0" =~ ^[0-9a-fA-F]{96}(,[0-9a-fA-F]{96})?$ ]] || { echo "ENCLAVE_PCR0 must be one or two (comma-separated) 96-hex-character values"; exit 1; }
  aws kms put-key-policy --key-id "$KEY" --policy-name default --policy "$(key_policy "$ENCLAVE_PCR0")"
  echo "kms key:    pinned to PCR0 $(echo "$ENCLAVE_PCR0" | sed -E 's/([0-9a-fA-F]{16})[0-9a-fA-F]{80}/\1…/g')"
fi

# --- Model API key: encrypted under the KMS key and stored as its ciphertext (a plain String).
# Set the env var the model's provider reads (src/constants.ts) to store or replace it; unset leaves
# the stored one alone. A key stored the old way (SecureString model-key) is migrated once.
# Passed by file, not argv.
KEY_ENV=$(cd "$HERE/.." && bun -e 'import { MODEL } from "./src/constants.ts"; console.log(MODEL.keyEnv)')
tmp=$(mktemp) && chmod 600 "$tmp"
trap 'rm -f "$tmp"' EXIT
from=""
if [ -n "${!KEY_ENV:-}" ]; then
  printf '%s' "${!KEY_ENV}" > "$tmp" && from=$KEY_ENV
elif ! aws ssm get-parameter --name /$NAME/model-key-ciphertext >/dev/null 2>&1 && aws ssm get-parameter --name /$NAME/model-key >/dev/null 2>&1; then
  printf '%s' "$(aws ssm get-parameter --name /$NAME/model-key --with-decryption --query Parameter.Value --output text)" > "$tmp" && from="the old SecureString"
fi
if [ -n "$from" ]; then
  ct=$(aws kms encrypt --key-id $KEY_ALIAS --plaintext "fileb://$tmp" --encryption-context $KEY_CONTEXT --query CiphertextBlob --output text)
  aws ssm put-parameter --name /$NAME/model-key-ciphertext --type String --overwrite --value "$ct" >/dev/null
  echo "model key:  encrypted under $KEY_ALIAS (from $from)"
fi
rm -f "$tmp"
if aws ssm get-parameter --name /$NAME/model-key >/dev/null 2>&1; then
  echo "note:       the old SecureString /$NAME/model-key still exists; the instance can't read it. Delete it once you hold the key elsewhere:"
  echo "            aws ssm delete-parameter --region us-east-1 --name /$NAME/model-key"
fi

# --- Security group: the app port, from CloudFront's origin-facing ranges only.
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name $NAME --description "Sikrets agent: CloudFront only" --vpc-id $VPC --tag-specifications "ResourceType=security-group,Tags=[{$TAGS}]" --query GroupId --output text)
  PL=$(aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing --query 'PrefixLists[0].PrefixListId' --output text)
  aws ec2 authorize-security-group-ingress --group-id $SG --ip-permissions "IpProtocol=tcp,FromPort=8787,ToPort=8787,PrefixListIds=[{PrefixListId=$PL,Description=CloudFront}]" >/dev/null
fi

# --- Instance: Graviton, Nitro Enclaves enabled, IMDSv2 required, encrypted root volume. It deploys
# DEPLOY_REF, resolved here to a commit SHA that user-data.sh checks the checkout against.
ID=$(aws ec2 describe-instances --filters Name=tag:Project,Values=$NAME Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ "$ID" = "None" ]; then
  [ -n "${DEPLOY_REF:-}" ] || { echo "Set DEPLOY_REF to the tag or commit SHA to deploy."; exit 1; }
  if [[ "$DEPLOY_REF" =~ ^[0-9a-f]{40}$ ]]; then
    SHA=$DEPLOY_REF
  else
    SHA=$(git ls-remote "$REPO" "refs/tags/$DEPLOY_REF^{}" "refs/tags/$DEPLOY_REF" | awk 'NR == 1 { print $1 }')
  fi
  [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "DEPLOY_REF $DEPLOY_REF is not a commit SHA or a tag of $REPO"; exit 1; }
  sed -e "s|__DEPLOY_REF__|$DEPLOY_REF|" -e "s|__DEPLOY_SHA__|$SHA|" "$HERE/user-data.sh" > "$tmp"
  AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)
  ID=$(aws ec2 run-instances --image-id $AMI --instance-type $TYPE \
    --iam-instance-profile Name=$NAME --security-group-ids $SG \
    --enclave-options Enabled=true \
    --metadata-options HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=2 \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3,Encrypted=true}' \
    --user-data "file://$tmp" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{$TAGS},{Key=DeployedSha,Value=$SHA}]" "ResourceType=volume,Tags=[{$TAGS}]" \
    --query 'Instances[0].InstanceId' --output text)
  rm -f "$tmp"
  aws ec2 wait instance-running --instance-ids $ID
fi
DNS=$(aws ec2 describe-instances --instance-ids $ID --query 'Reservations[0].Instances[0].PublicDnsName' --output text)

# --- CloudFront: HTTPS in front, nothing cached, cookies and the viewer address passed through.
DIST=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$NAME'].Id | [0]" --output text)
if [ "$DIST" = "None" ]; then
  DIST=$(aws cloudfront create-distribution-with-tags --distribution-config-with-tags "$(cat <<EOF
{"DistributionConfig":{
  "CallerReference":"$NAME-$(date +%s)","Comment":"$NAME","Enabled":true,"PriceClass":"PriceClass_100","HttpVersion":"http2and3",
  "Origins":{"Quantity":1,"Items":[{"Id":"agent","DomainName":"$DNS","CustomOriginConfig":{"HTTPPort":8787,"HTTPSPort":443,"OriginProtocolPolicy":"http-only","OriginReadTimeout":60,"OriginKeepaliveTimeout":30}}]},
  "DefaultCacheBehavior":{"TargetOriginId":"agent","ViewerProtocolPolicy":"redirect-to-https","Compress":false,
    "AllowedMethods":{"Quantity":7,"Items":["GET","HEAD","OPTIONS","PUT","POST","PATCH","DELETE"],"CachedMethods":{"Quantity":2,"Items":["GET","HEAD"]}},
    "CachePolicyId":"4135ea2d-6df8-44a3-9df3-4b5a84be39ad","OriginRequestPolicyId":"33f36d7e-f396-46d9-90e0-52428a34d9dc"}
},"Tags":{"Items":[{"Key":"Project","Value":"$NAME"}]}}
EOF
)" --query Distribution.Id --output text)
fi
DOMAIN=$(aws cloudfront get-distribution --id $DIST --query Distribution.DomainName --output text)

# --- Alerts: one SNS topic for the alarms and the budget. Subscribers are up to you (ALERT_EMAIL,
# or any other SNS subscription); none is created otherwise.
TOPIC=$(aws sns create-topic --name $NAME-alerts --tags $TAGS --query TopicArn --output text)
aws sns set-topic-attributes --topic-arn "$TOPIC" --attribute-name Policy --attribute-value "$(cat <<EOF
{"Version":"2012-10-17","Statement":[
 {"Sid":"Owner","Effect":"Allow","Principal":{"AWS":"arn:aws:iam::$ACCOUNT:root"},"Action":["sns:Publish","sns:Subscribe","sns:GetTopicAttributes","sns:SetTopicAttributes","sns:ListSubscriptionsByTopic"],"Resource":"$TOPIC"},
 {"Sid":"Alarms","Effect":"Allow","Principal":{"Service":"cloudwatch.amazonaws.com"},"Action":"sns:Publish","Resource":"$TOPIC","Condition":{"StringEquals":{"aws:SourceAccount":"$ACCOUNT"}}},
 {"Sid":"Budgets","Effect":"Allow","Principal":{"Service":"budgets.amazonaws.com"},"Action":"sns:Publish","Resource":"$TOPIC","Condition":{"StringEquals":{"aws:SourceAccount":"$ACCOUNT"}}}
]}
EOF
)"
if [ -n "${ALERT_EMAIL:-}" ]; then
  aws sns subscribe --topic-arn "$TOPIC" --protocol email --notification-endpoint "$ALERT_EMAIL" >/dev/null
  echo "alerts:     subscription requested; confirm it from the email AWS sends"
fi

# --- Alarms: the enclave heartbeat (host.sh's watch sends 1 a minute while the enclave runs and its
# gateway answers /healthz; 0 or silence for 3 minutes alarms), and the share of 5xx responses
# CloudFront serves (the gateway's errors, or no gateway at all).
aws cloudwatch put-metric-alarm --alarm-name $NAME-enclave-health --tags $TAGS \
  --alarm-description "The agent enclave stopped running, or its gateway stopped answering /healthz." \
  --namespace $METRICS --metric-name EnclaveHealthy --statistic Minimum --period 60 \
  --evaluation-periods 3 --datapoints-to-alarm 3 --threshold 1 --comparison-operator LessThanThreshold \
  --treat-missing-data breaching --alarm-actions "$TOPIC" --ok-actions "$TOPIC"
aws cloudwatch put-metric-alarm --alarm-name $NAME-gateway-5xx --tags $TAGS \
  --alarm-description "More than 5% of requests through CloudFront got a 5xx from the gateway." \
  --namespace AWS/CloudFront --metric-name 5xxErrorRate --dimensions Name=DistributionId,Value=$DIST Name=Region,Value=Global \
  --statistic Average --period 300 --evaluation-periods 3 --datapoints-to-alarm 2 --threshold 5 --comparison-operator GreaterThanThreshold \
  --treat-missing-data notBreaching --alarm-actions "$TOPIC" --ok-actions "$TOPIC"

# --- Budget: this stack's monthly cost (resources tagged Project=$NAME), alerting at $BUDGET_USD
# actual and forecast. The tag must be active for cost allocation; activating it takes up to a day
# and counts costs from then on.
aws ce update-cost-allocation-tags-status --cost-allocation-tags-status TagKey=Project,Status=Active >/dev/null
alert() { echo "{\"Notification\":{\"NotificationType\":\"$1\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":100,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[{\"SubscriptionType\":\"SNS\",\"Address\":\"$TOPIC\"}]}"; }
BUDGET="{\"BudgetName\":\"$NAME\",\"BudgetType\":\"COST\",\"TimeUnit\":\"MONTHLY\",\"BudgetLimit\":{\"Amount\":\"$BUDGET_USD\",\"Unit\":\"USD\"},\"CostFilters\":{\"TagKeyValue\":[\"user:Project\$$NAME\"]}}"
if aws budgets describe-budget --account-id $ACCOUNT --budget-name $NAME >/dev/null 2>&1; then
  aws budgets update-budget --account-id $ACCOUNT --new-budget "$BUDGET"
else
  aws budgets create-budget --account-id $ACCOUNT --budget "$BUDGET" --notifications-with-subscribers "[$(alert ACTUAL),$(alert FORECASTED)]"
fi

echo "instance:   $ID ($TYPE, $DNS)"
echo "sg:         $SG"
echo "kms key:    $KEY_ALIAS ($KEY)"
echo "cloudfront: $DIST"
echo "alerts:     $TOPIC (alarms $NAME-enclave-health, $NAME-gateway-5xx; budget $NAME, \$$BUDGET_USD/month)"
echo "url:        https://$DOMAIN"
