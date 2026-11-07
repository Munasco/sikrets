#!/bin/bash
# Deploys the relay to AWS in us-east-1: a DynamoDB table (on-demand, TTL on "exp"), an IAM role
# that can only put, query and delete items in that table, and a Node Lambda behind a public
# Function URL. Safe to re-run: existing pieces are reused and the code is updated. Prints the URL.
# The relay holds only ciphertext under opaque box ids, so there is nothing secret to configure.
set -euo pipefail
export AWS_REGION=us-east-1 AWS_PAGER=""
NAME=sikrets-relay
TABLE=$NAME
TAGS_KV="Key=Project,Value=$NAME"
HERE=$(cd "$(dirname "$0")/.." && pwd)
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
CONCURRENCY=${RELAY_CONCURRENCY:-10}

# --- Table: box (partition) + id (sort), expired items removed by TTL.
if ! aws dynamodb describe-table --table-name $TABLE >/dev/null 2>&1; then
  aws dynamodb create-table --table-name $TABLE --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=box,AttributeType=S AttributeName=id,AttributeType=S \
    --key-schema AttributeName=box,KeyType=HASH AttributeName=id,KeyType=RANGE --tags $TAGS_KV >/dev/null
  aws dynamodb wait table-exists --table-name $TABLE
  aws dynamodb update-time-to-live --table-name $TABLE --time-to-live-specification Enabled=true,AttributeName=exp >/dev/null
  echo "table: created"
fi

# --- Role: this table's items, and its own logs. Nothing else.
if ! aws iam get-role --role-name $NAME >/dev/null 2>&1; then
  aws iam create-role --role-name $NAME --tags $TAGS_KV --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  echo "role: created"
  sleep 10 # new roles take a moment before Lambda can assume them
fi
aws iam put-role-policy --role-name $NAME --policy-name relay --policy-document "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["dynamodb:PutItem","dynamodb:Query","dynamodb:DeleteItem"],"Resource":"arn:aws:dynamodb:$AWS_REGION:$ACCOUNT:table/$TABLE"},
 {"Effect":"Allow","Action":["logs:CreateLogGroup","logs:CreateLogStream","logs:PutLogEvents"],"Resource":"arn:aws:logs:$AWS_REGION:$ACCOUNT:log-group:/aws/lambda/$NAME:*"}
]}
JSON
)"

# --- Code.
(cd "$HERE" && bun run build >/dev/null)
ZIP=$(mktemp -d)/relay.zip
(cd "$HERE/dist" && zip -q "$ZIP" index.mjs)

if ! aws lambda get-function --function-name $NAME >/dev/null 2>&1; then
  aws lambda create-function --function-name $NAME --runtime nodejs22.x --architectures arm64 \
    --handler index.handler --role arn:aws:iam::$ACCOUNT:role/$NAME --zip-file fileb://$ZIP \
    --memory-size 256 --timeout 10 --environment "Variables={RELAY_TABLE=$TABLE}" --tags Project=$NAME >/dev/null
  aws lambda wait function-active-v2 --function-name $NAME
  echo "function: created"
else
  aws lambda update-function-code --function-name $NAME --zip-file fileb://$ZIP >/dev/null
  aws lambda wait function-updated-v2 --function-name $NAME
  echo "function: updated"
fi
# Caps cost and abuse. Fails harmlessly on accounts with too little unreserved concurrency.
aws lambda put-function-concurrency --function-name $NAME --reserved-concurrent-executions $CONCURRENCY >/dev/null 2>&1 || echo "concurrency: left unreserved"

# --- Public Function URL. The relay authenticates nothing: every blob is end-to-end encrypted and
# box ids are unguessable.
if ! aws lambda get-function-url-config --function-name $NAME >/dev/null 2>&1; then
  aws lambda create-function-url-config --function-name $NAME --auth-type NONE >/dev/null
  aws lambda add-permission --function-name $NAME --statement-id public-url --action lambda:InvokeFunctionUrl \
    --principal '*' --function-url-auth-type NONE >/dev/null
  aws lambda add-permission --function-name $NAME --statement-id public-invoke --action lambda:InvokeFunction \
    --principal '*' --invoked-via-function-url >/dev/null 2>&1 || true
fi
aws lambda get-function-url-config --function-name $NAME --query FunctionUrl --output text
