#!/bin/bash
# Installed as /usr/local/bin/sikrets-agent-env. Writes the agent's runtime env file (tmpfs) from SSM
# Parameter Store: the access code. Used when the agent runs on the host (host.sh down). The model
# key is not here: it's stored encrypted under a KMS key only the enclave image can use, so on the
# host the agent starts without one and can't answer chats. Inside the enclave, the access code
# arrives over vsock and the enclave decrypts the key itself.
set -euo pipefail
param() { aws ssm get-parameter --region us-east-1 --name "/sikrets-agent-demo/$1" --with-decryption --query Parameter.Value --output text; }
umask 077
printf 'ACCESS_CODE=%s\n' "$(param access-code)" > /run/sikrets-agent.env
chown sikrets /run/sikrets-agent.env
