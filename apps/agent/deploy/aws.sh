#!/bin/bash
# Provisions the hosted demo in us-east-1: an IAM role that can only read the access code and the
# model key's ciphertext and send a heartbeat, a KMS key only the enclave image can decrypt with, a
# Graviton instance with Nitro Enclaves enabled (SSM-managed, no SSH, IMDSv2 only) reachable only
# from CloudFront, a CloudFront distribution for HTTPS, and alarms and a monthly budget that alert an
# SNS topic. Safe to re-run: existing pieces are reused. Prints IDs and the URL, never a secret.
#
#   GEMINI_API_KEY=…    store or replace the model key (encrypted under the KMS key; MODEL.keyEnv)
#   ENCLAVE_PCR0=…      pin the KMS key to this enclave build (host.sh build prints it); during a
#                       switch, "<old>,<new>" lets both decrypt, then pin the new one alone. A pin
#                       that leaves out the PCR0 running now (from /attestation) is refused, since
#                       the live enclave would lose the key at its next restart; FORCE_PCR0=1 overrides
#   INSTANCE_ID=…       which instance to wire up, when more than one is tagged for this stack
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
# A two-PCR0 pin is for a switch; older than this, it's a reminder to narrow it.
DUAL_PIN_HOURS=${DUAL_PIN_HOURS:-24}
PLACEHOLDER_PCR0=$(printf '0%.0s' {1..96})
TLS_HOST=$(cd "$HERE/.." && bun -e 'import { TLS } from "./src/constants.ts"; console.log(TLS.host)')
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

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

# --- IAM role: read the access code, the key's ciphertext and which PCR0s are pinned, send the
# heartbeat, and keep its own DeployedSha tag current. Nothing else: no SSM parameter by wildcard,
# and no KMS permission (the key policy below grants Decrypt to this role only with the enclave's
# attestation).
if ! aws iam get-role --role-name $NAME >/dev/null 2>&1; then
  aws iam create-role --role-name $NAME --tags $TAGS --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name $NAME --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
fi
aws iam put-role-policy --role-name $NAME --policy-name agent --policy-document "$(cat <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":"ssm:GetParameter","Resource":["arn:aws:ssm:us-east-1:$ACCOUNT:parameter/$NAME/access-code","arn:aws:ssm:us-east-1:$ACCOUNT:parameter/$NAME/model-key-ciphertext","arn:aws:ssm:us-east-1:$ACCOUNT:parameter/$NAME/pinned-pcr0"]},
 {"Effect":"Allow","Action":"cloudwatch:PutMetricData","Resource":"*","Condition":{"StringEquals":{"cloudwatch:namespace":"$METRICS"}}},
 {"Effect":"Allow","Action":"ec2:CreateTags","Resource":"arn:aws:ec2:us-east-1:$ACCOUNT:instance/*","Condition":{"StringEquals":{"aws:ResourceTag/Project":"$NAME"},"ForAllValues:StringEquals":{"aws:TagKeys":["DeployedSha"]}}}
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
 {"Sid":"EnclaveDecrypt","Effect":"Allow","Principal":{"AWS":"arn:aws:iam::$ACCOUNT:role/$NAME"},"Action":["kms:Decrypt","kms:GenerateDataKey"],"Resource":"*",
  "Condition":{"StringEqualsIgnoreCase":{"kms:RecipientAttestation:ImageSha384":[$(echo "$1" | sed 's/[^,][^,]*/"&"/g')]}}}
]}
EOF
}
KEY=$(aws kms describe-key --key-id $KEY_ALIAS --query KeyMetadata.KeyId --output text 2>/dev/null || true)
if [ -z "$KEY" ]; then
  # A run that died between create-key and create-alias left a tagged key with no alias: adopt it
  # rather than make a second one.
  for arn in $(aws resourcegroupstaggingapi get-resources --resource-type-filters kms:key --tag-filters Key=Project,Values=$NAME --query 'ResourceTagMappingList[].ResourceARN' --output text); do
    if [ "$(aws kms describe-key --key-id "$arn" --query KeyMetadata.KeyState --output text)" = Enabled ]; then KEY=${arn##*/}; break; fi
  done
  if [ -z "$KEY" ]; then
    KEY=$(aws kms create-key --description "$NAME model key: decrypts only inside the attested enclave" --tags TagKey=Project,TagValue=$NAME \
      --policy "$(key_policy "$PLACEHOLDER_PCR0")" --query KeyMetadata.KeyId --output text)
  fi
  aws kms create-alias --alias-name $KEY_ALIAS --target-key-id "$KEY"
  aws kms enable-key-rotation --key-id "$KEY"
fi

# The PCR0s the key allows now, read from its policy (the placeholder left out), one per line.
pinned() {
  aws kms get-key-policy --key-id "$KEY" --policy-name default --query Policy --output text | python3 -c '
import json, sys
for s in json.load(sys.stdin)["Statement"]:
    if s.get("Sid") == "EnclaveDecrypt":
        v = s["Condition"]["StringEqualsIgnoreCase"]["kms:RecipientAttestation:ImageSha384"]
        for x in [v] if isinstance(v, str) else v:
            if x.strip("0"):
                print(x.lower())'
}
# The PCR0 of the enclave serving now, from its attestation (TLS host first, then CloudFront);
# empty if none answers or it isn't an enclave.
live_pcr0() {
  local cf
  cf=$(aws cloudfront list-distributions --query "DistributionList.Items[?Comment=='$NAME'].DomainName | [0]" --output text 2>/dev/null || true)
  for url in "https://$TLS_HOST/attestation" ${cf:+"https://$cf/attestation"}; do
    if curl -fsS -m 10 "$url" -o "$work/attestation.json" 2>/dev/null; then
      python3 -c 'import json, sys; print(json.load(open(sys.argv[1])).get("pcrs", {}).get("0", "").lower())' "$work/attestation.json" && return 0
    fi
  done
}

if [ -n "${ENCLAVE_PCR0:-}" ]; then
  [[ "$ENCLAVE_PCR0" =~ ^[0-9a-fA-F]{96}(,[0-9a-fA-F]{96})?$ ]] || { echo "ENCLAVE_PCR0 must be one or two (comma-separated) 96-hex-character values"; exit 1; }
  WANT=$(echo "$ENCLAVE_PCR0" | tr 'A-F' 'a-f')
  LIVE=$(live_pcr0 || true)
  if [ "${FORCE_PCR0:-}" != 1 ]; then
    if [ -n "$LIVE" ] && ! echo "$WANT" | tr ',' '\n' | grep -qx "$LIVE"; then
      echo "Refusing: the enclave running now has PCR0 ${LIVE:0:16}…, which this pin leaves out. It would lose the model key"
      echo "and its TLS key at its next restart. Pin it alongside (ENCLAVE_PCR0=$LIVE,<new>), or FORCE_PCR0=1."
      exit 1
    fi
    if [ -z "$LIVE" ] && [ -n "$(pinned)" ]; then
      echo "Refusing: no enclave answered /attestation, so this can't check the pin keeps the live image. FORCE_PCR0=1 to pin anyway."
      exit 1
    fi
  fi
  aws kms put-key-policy --key-id "$KEY" --policy-name default --policy "$(key_policy "$WANT")"
  echo "kms key:    pinned to PCR0 $(echo "$WANT" | sed -E 's/([0-9a-f]{16})[0-9a-f]{80}/\1…/g')"
fi

# What's pinned, mirrored to SSM for host.sh (it refuses to start an image the key won't allow),
# with when this set was first seen. Read back from the policy each run, so it never drifts.
PINS=$(pinned)
since=$(aws ssm get-parameter --name /$NAME/pinned-pcr0 --query Parameter.Value --output text 2>/dev/null |
  python3 -c 'import json, sys
try:
    d = json.load(sys.stdin)
    print(d["since"] if sorted(d["pcr0"]) == sorted(sys.argv[1].split()) else "")
except Exception:
    print("")' "$PINS" || true)
since=${since:-$(date +%s)}
pins_json=$(python3 -c 'import json, sys; print(json.dumps({"pcr0": sys.argv[1].split(), "since": int(sys.argv[2])}))' "$PINS" "$since")
aws ssm put-parameter --name /$NAME/pinned-pcr0 --type String --overwrite --value "$pins_json" >/dev/null
if [ "$(echo "$PINS" | grep -c .)" -gt 1 ] && [ $(( $(date +%s) - since )) -gt $((DUAL_PIN_HOURS * 3600)) ]; then
  echo "warning:    the KMS key has allowed two PCR0s for over $DUAL_PIN_HOURS hours. Once the new image is verified,"
  echo "            pin it alone: ENCLAVE_PCR0=<live PCR0> deploy/aws.sh"
fi

# --- Model API key: encrypted under the KMS key and stored as its ciphertext (a plain String).
# Set the env var the model's provider reads (src/constants.ts) to store or replace it; unset leaves
# the stored one alone. A key stored the old way (SecureString model-key) is migrated once.
# Passed by file, not argv.
KEY_ENV=$(cd "$HERE/.." && bun -e 'import { MODEL } from "./src/constants.ts"; console.log(MODEL.keyEnv)')
tmp=$(mktemp) && chmod 600 "$tmp"
trap 'rm -f "$tmp"; rm -rf "$work"' EXIT
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

# --- HTTPS ended inside the enclave: a network load balancer passes TCP through to the instance:
# 443 with a PROXY v2 header naming the client (the gateway rate-limits by it), and 80 for the
# certificate's HTTP-01 challenge. The host relays both over vsock without decrypting anything.
# Client addresses reach the instance as they are, so these two ports are open to everyone.
for port in 443 80; do
  for cidr in "CidrIp=0.0.0.0/0" "CidrIpv6=::/0"; do
    range=$([ "${cidr%%=*}" = CidrIp ] && echo IpRanges || echo Ipv6Ranges)
    aws ec2 authorize-security-group-ingress --group-id $SG --ip-permissions "IpProtocol=tcp,FromPort=$port,ToPort=$port,$range=[{$cidr,Description=agent-tls}]" >/dev/null 2>&1 || true
  done
done

# --- Instance: Graviton, Nitro Enclaves enabled, IMDSv2 required, encrypted root volume. It deploys
# DEPLOY_REF, resolved here to a commit SHA that user-data.sh checks the checkout against.
IDS=$(aws ec2 describe-instances --filters Name=tag:Project,Values=$NAME Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[].Instances[].InstanceId' --output text)
if [ "$(echo $IDS | wc -w)" -gt 1 ]; then
  # Never wire up whichever came first: say which.
  [ -n "${INSTANCE_ID:-}" ] && [[ " $IDS " == *" $INSTANCE_ID "* ]] || { echo "More than one instance is tagged Project=$NAME ($IDS); set INSTANCE_ID to the one to use."; exit 1; }
  ID=$INSTANCE_ID
else
  ID=${IDS:-None}
fi
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

# --- The load balancer itself (see the security group above), in the default VPC's subnets.
NLB=$(aws elbv2 describe-load-balancers --names $NAME --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)
if [ -z "$NLB" ] || [ "$NLB" = None ]; then
  SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=default-for-az,Values=true --query 'Subnets[].SubnetId' --output text)
  NLB=$(aws elbv2 create-load-balancer --name $NAME --type network --scheme internet-facing --subnets $SUBNETS --tags Key=Project,Value=$NAME --query 'LoadBalancers[0].LoadBalancerArn' --output text)
fi
for pair in tls:443 http:80; do
  tg=$NAME-${pair%%:*} port=${pair##*:}
  TG=$(aws elbv2 describe-target-groups --names $tg --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
  if [ -z "$TG" ] || [ "$TG" = None ]; then
    TG=$(aws elbv2 create-target-group --name $tg --protocol TCP --port $port --vpc-id $VPC --target-type instance --health-check-protocol TCP --tags Key=Project,Value=$NAME --query 'TargetGroups[0].TargetGroupArn' --output text)
  fi
  [ "$port" = 443 ] && aws elbv2 modify-target-group-attributes --target-group-arn $TG --attributes Key=proxy_protocol_v2.enabled,Value=true >/dev/null
  aws elbv2 register-targets --target-group-arn $TG --targets Id=$ID,Port=$port
  # A replaced instance's registration goes.
  for old in $(aws elbv2 describe-target-health --target-group-arn $TG --query "TargetHealthDescriptions[?Target.Id!='$ID'].Target.Id" --output text); do
    aws elbv2 deregister-targets --target-group-arn $TG --targets Id=$old,Port=$port
  done
  if [ "$(aws elbv2 describe-listeners --load-balancer-arn $NLB --query "Listeners[?Port==\`$port\`] | length(@)" --output text)" = 0 ]; then
    aws elbv2 create-listener --load-balancer-arn $NLB --protocol TCP --port $port --default-actions Type=forward,TargetGroupArn=$TG >/dev/null
  fi
done
NLB_DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns $NLB --query 'LoadBalancers[0].DNSName' --output text)

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
# A replaced instance has a new DNS name: point the existing distribution's origin at it.
aws cloudfront get-distribution-config --id $DIST > "$work/dist.json"
ORIGIN=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["DistributionConfig"]["Origins"]["Items"][0]["DomainName"])' "$work/dist.json")
if [ "$ORIGIN" != "$DNS" ]; then
  python3 -c 'import json, sys
d = json.load(open(sys.argv[1]))
d["DistributionConfig"]["Origins"]["Items"][0]["DomainName"] = sys.argv[2]
json.dump(d["DistributionConfig"], open(sys.argv[3], "w"))' "$work/dist.json" "$DNS" "$work/dist-config.json"
  ETAG=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["ETag"])' "$work/dist.json")
  aws cloudfront update-distribution --id $DIST --if-match "$ETAG" --distribution-config "file://$work/dist-config.json" >/dev/null
  echo "cloudfront: origin moved from $ORIGIN to $DNS"
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
echo "url:        https://$DOMAIN (CloudFront; TLS ends at CloudFront)"
echo "tls url:    https://$TLS_HOST (TLS ends in the enclave; DNS: CNAME $TLS_HOST -> $NLB_DNS)"
