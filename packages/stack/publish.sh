#!/usr/bin/env bash
# Publishes sikrets.yaml to the public template bucket that `sikrets cloud connect --link` points at.
# Only objects under stack/ are publicly readable. Needs write access to the bucket.
set -euo pipefail
BUCKET="sikrets-stack-templates"
KEY="stack/v1/sikrets.yaml"
DIR="$(cd "$(dirname "$0")" && pwd)"
aws cloudformation validate-template --region us-east-1 --template-body "file://$DIR/sikrets.yaml" >/dev/null
aws s3 cp "$DIR/sikrets.yaml" "s3://$BUCKET/$KEY" --content-type "application/x-yaml" --cache-control "max-age=300"
echo "https://$BUCKET.s3.amazonaws.com/$KEY"
