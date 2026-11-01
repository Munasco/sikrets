#!/bin/bash
# Installed as /usr/local/bin/sikrets-agent-env. Writes the agent's runtime env file (tmpfs) from SSM
# Parameter Store: the access code and the model API key. Used when the agent runs on the host
# (host.sh down); inside the enclave the same values arrive over vsock instead.
set -euo pipefail
param() { aws ssm get-parameter --region us-east-1 --name "/sikrets-agent-demo/$1" --with-decryption --query Parameter.Value --output text; }
umask 077
printf 'ACCESS_CODE=%s\nMODEL_API_KEY=%s\n' "$(param access-code)" "$(param model-key)" > /run/sikrets-agent.env
chown sikrets /run/sikrets-agent.env
