#!/bin/bash
# Provisions the hosted demo in us-east-1: an IAM role that can call only the agent's Bedrock
# models and read its access code, a Graviton instance with Nitro Enclaves enabled (SSM-managed,
# no SSH, IMDSv2 only) reachable only from CloudFront, and a CloudFront distribution for HTTPS.
# Safe to re-run: existing pieces are reused. Prints IDs and the URL, never the access code.
set -euo pipefail
export AWS_REGION=us-east-1 AWS_PAGER=""
NAME=sikrets-agent-demo
TAGS="Key=Project,Value=$NAME"
HERE=$(cd "$(dirname "$0")" && pwd)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
TYPE=${INSTANCE_TYPE:-c7g.xlarge}

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

# --- IAM role
if ! aws iam get-role --role-name $NAME >/dev/null 2>&1; then
  aws iam create-role --role-name $NAME --tags $TAGS --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name $NAME --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
fi
aws iam put-role-policy --role-name $NAME --policy-name agent --policy-document "$(cat <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream"],"Resource":[
   "arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-oss-120b-1:0",
   "arn:aws:bedrock:us-east-1::foundation-model/openai.gpt-oss-20b-1:0"]},
 {"Effect":"Allow","Action":"ssm:GetParameter","Resource":"arn:aws:ssm:us-east-1:$ACCOUNT:parameter/$NAME/*"}
]}
EOF
)"
if ! aws iam get-instance-profile --instance-profile-name $NAME >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name $NAME --tags $TAGS >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name $NAME --role-name $NAME
  sleep 10 # instance profiles take a moment to be usable
fi

# --- Security group: the app port, from CloudFront's origin-facing ranges only.
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
SG=$(aws ec2 describe-security-groups --filters Name=group-name,Values=$NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text)
if [ "$SG" = "None" ]; then
  SG=$(aws ec2 create-security-group --group-name $NAME --description "Sikrets agent: CloudFront only" --vpc-id $VPC --tag-specifications "ResourceType=security-group,Tags=[{$TAGS}]" --query GroupId --output text)
  PL=$(aws ec2 describe-managed-prefix-lists --filters Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing --query 'PrefixLists[0].PrefixListId' --output text)
  aws ec2 authorize-security-group-ingress --group-id $SG --ip-permissions "IpProtocol=tcp,FromPort=8787,ToPort=8787,PrefixListIds=[{PrefixListId=$PL,Description=CloudFront}]" >/dev/null
fi

# --- Instance: Graviton, Nitro Enclaves enabled, IMDSv2 required, encrypted root volume.
ID=$(aws ec2 describe-instances --filters Name=tag:Project,Values=$NAME Name=instance-state-name,Values=pending,running,stopping,stopped --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ "$ID" = "None" ]; then
  AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)
  ID=$(aws ec2 run-instances --image-id $AMI --instance-type $TYPE \
    --iam-instance-profile Name=$NAME --security-group-ids $SG \
    --enclave-options Enabled=true \
    --metadata-options HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=2 \
    --block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3,Encrypted=true}' \
    --user-data "file://$HERE/user-data.sh" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{$TAGS}]" "ResourceType=volume,Tags=[{$TAGS}]" \
    --query 'Instances[0].InstanceId' --output text)
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

echo "instance:   $ID ($TYPE, $DNS)"
echo "sg:         $SG"
echo "cloudfront: $DIST"
echo "url:        https://$DOMAIN"
