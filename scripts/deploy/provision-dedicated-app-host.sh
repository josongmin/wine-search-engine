#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  provision-dedicated-app-host.sh \
    --region ap-northeast-2 \
    --subnet-id subnet-abc123 \
    --ingress-source-sg-id sg-shared-ingress \
    --vespa-sg-id sg-vespa \
    --instance-profile-name EC2SSMManagedProfileTemp

Options:
  --instance-name wine-search-engine-app-prod
  --instance-type t3.medium
  --volume-size-gb 30
  --security-group-name wine-search-engine-app-prod
  --ami-id ami-...
  --host-port 4000
  --app-port 3000
  --env-file /etc/wine-search-engine.env
  --key-name optional-keypair
EOF
}

REGION=""
SUBNET_ID=""
INGRESS_SOURCE_SG_ID=""
VESPA_SG_ID=""
INSTANCE_PROFILE_NAME=""
INSTANCE_NAME="wine-search-engine-app-prod"
INSTANCE_TYPE="t3.medium"
VOLUME_SIZE_GB="30"
SECURITY_GROUP_NAME="wine-search-engine-app-prod"
AMI_ID=""
HOST_PORT="4000"
APP_PORT="3000"
ENV_FILE="/etc/wine-search-engine.env"
KEY_NAME=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --region) REGION="$2"; shift 2 ;;
    --subnet-id) SUBNET_ID="$2"; shift 2 ;;
    --ingress-source-sg-id) INGRESS_SOURCE_SG_ID="$2"; shift 2 ;;
    --vespa-sg-id) VESPA_SG_ID="$2"; shift 2 ;;
    --instance-profile-name) INSTANCE_PROFILE_NAME="$2"; shift 2 ;;
    --instance-name) INSTANCE_NAME="$2"; shift 2 ;;
    --instance-type) INSTANCE_TYPE="$2"; shift 2 ;;
    --volume-size-gb) VOLUME_SIZE_GB="$2"; shift 2 ;;
    --security-group-name) SECURITY_GROUP_NAME="$2"; shift 2 ;;
    --ami-id) AMI_ID="$2"; shift 2 ;;
    --host-port) HOST_PORT="$2"; shift 2 ;;
    --app-port) APP_PORT="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --key-name) KEY_NAME="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

for key in REGION SUBNET_ID INGRESS_SOURCE_SG_ID VESPA_SG_ID INSTANCE_PROFILE_NAME; do
  if [[ -z "${!key}" ]]; then
    echo "Missing required argument: ${key}" >&2
    usage
    exit 1
  fi
done

if [[ -z "$AMI_ID" ]]; then
  AMI_ID="$(
    aws ec2 describe-images \
      --region "$REGION" \
      --owners 099720109477 \
      --filters \
        'Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*' \
        'Name=state,Values=available' \
      --query 'reverse(sort_by(Images,&CreationDate))[0].ImageId' \
      --output text
  )"
fi

if [[ -z "$AMI_ID" || "$AMI_ID" == "None" ]]; then
  echo "Failed to resolve Ubuntu 24.04 AMI." >&2
  exit 1
fi

VPC_ID="$(
  aws ec2 describe-subnets \
    --region "$REGION" \
    --subnet-ids "$SUBNET_ID" \
    --query 'Subnets[0].VpcId' \
    --output text
)"

if [[ -z "$VPC_ID" || "$VPC_ID" == "None" ]]; then
  echo "Failed to resolve VPC from subnet: $SUBNET_ID" >&2
  exit 1
fi

SG_ID="$(
  aws ec2 describe-security-groups \
    --region "$REGION" \
    --filters "Name=vpc-id,Values=$VPC_ID" "Name=group-name,Values=$SECURITY_GROUP_NAME" \
    --query 'SecurityGroups[0].GroupId' \
    --output text
)"

if [[ -z "$SG_ID" || "$SG_ID" == "None" ]]; then
  SG_ID="$(
    aws ec2 create-security-group \
      --region "$REGION" \
      --group-name "$SECURITY_GROUP_NAME" \
      --description "Dedicated app host for wine-search-engine" \
      --vpc-id "$VPC_ID" \
      --tag-specifications "ResourceType=security-group,Tags=[{Key=Name,Value=$SECURITY_GROUP_NAME},{Key=Service,Value=wine-search-engine},{Key=Role,Value=app-host}]" \
      --query 'GroupId' \
      --output text
  )"
fi

authorize_ingress_rule() {
  local group_id="$1"
  local port="$2"
  local source_group_id="$3"
  local output=""
  local status=0

  output="$(
    aws ec2 authorize-security-group-ingress \
      --region "$REGION" \
      --group-id "$group_id" \
      --ip-permissions "IpProtocol=tcp,FromPort=$port,ToPort=$port,UserIdGroupPairs=[{GroupId=$source_group_id}]" \
      2>&1
  )" || status=$?

  if [[ "$status" -ne 0 && "$output" != *"InvalidPermission.Duplicate"* ]]; then
    echo "$output" >&2
    exit "$status"
  fi
}

authorize_ingress_rule "$SG_ID" "$HOST_PORT" "$INGRESS_SOURCE_SG_ID"
authorize_ingress_rule "$VESPA_SG_ID" "8080" "$SG_ID"
authorize_ingress_rule "$VESPA_SG_ID" "19071" "$SG_ID"
authorize_ingress_rule "$VESPA_SG_ID" "19092" "$SG_ID"

tmp_block_device="$(mktemp)"
tmp_bootstrap=""
trap 'rm -f "$tmp_block_device" "$tmp_bootstrap"' EXIT

python - "$tmp_block_device" "$VOLUME_SIZE_GB" <<'PY'
import json
import sys

path = sys.argv[1]
volume_size_gb = int(sys.argv[2])
with open(path, "w", encoding="utf-8") as fh:
    json.dump(
        [
            {
                "DeviceName": "/dev/sda1",
                "Ebs": {
                    "VolumeSize": volume_size_gb,
                    "VolumeType": "gp3",
                    "DeleteOnTermination": True,
                },
            }
        ],
        fh,
    )
PY

declare -a run_args=(
  ec2 run-instances
  --region "$REGION"
  --image-id "$AMI_ID"
  --instance-type "$INSTANCE_TYPE"
  --iam-instance-profile "Name=$INSTANCE_PROFILE_NAME"
  --network-interfaces "DeviceIndex=0,AssociatePublicIpAddress=true,SubnetId=$SUBNET_ID,Groups=$SG_ID"
  --block-device-mappings "file://$tmp_block_device"
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$INSTANCE_NAME},{Key=Service,Value=wine-search-engine},{Key=Role,Value=dedicated-app-host}]" "ResourceType=volume,Tags=[{Key=Name,Value=$INSTANCE_NAME-root},{Key=Service,Value=wine-search-engine}]"
  --query 'Instances[0].InstanceId'
  --output text
)

if [[ -n "$KEY_NAME" ]]; then
  run_args+=(--key-name "$KEY_NAME")
fi

INSTANCE_ID="$(aws "${run_args[@]}")"

aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"
aws ec2 wait instance-status-ok --region "$REGION" --instance-ids "$INSTANCE_ID"

for _ in $(seq 1 60); do
  ssm_status="$(
    aws ssm describe-instance-information \
      --region "$REGION" \
      --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
      --query 'InstanceInformationList[0].PingStatus' \
      --output text 2>/dev/null || true
  )"
  if [[ "$ssm_status" == "Online" ]]; then
    break
  fi
  sleep 10
done

if [[ "${ssm_status:-}" != "Online" ]]; then
  echo "Instance did not become SSM Online: $INSTANCE_ID" >&2
  exit 1
fi

tmp_bootstrap="$(mktemp)"
BOOTSTRAP_SCRIPT_B64="$(
  base64 < "$(dirname "$0")/bootstrap-app-host.sh" | tr -d '\n'
)"
BOOTSTRAP_SCRIPT_B64="$BOOTSTRAP_SCRIPT_B64" \
ENV_FILE="$ENV_FILE" \
HOST_PORT="$HOST_PORT" \
APP_PORT="$APP_PORT" \
python - "$tmp_bootstrap" <<'PY'
import json
import os
import sys

path = sys.argv[1]
commands = [
    "set -eu",
    f"BOOTSTRAP_SCRIPT_B64='{os.environ['BOOTSTRAP_SCRIPT_B64']}'",
    "printf '%s' \"$BOOTSTRAP_SCRIPT_B64\" | base64 -d >/tmp/bootstrap-app-host.sh",
    "chmod +x /tmp/bootstrap-app-host.sh",
    f"ENV_FILE='{os.environ['ENV_FILE']}' HOST_PORT='{os.environ['HOST_PORT']}' APP_PORT='{os.environ['APP_PORT']}' /tmp/bootstrap-app-host.sh",
]
with open(path, "w", encoding="utf-8") as fh:
    json.dump({"commands": commands}, fh)
PY

command_id="$(
  aws ssm send-command \
    --region "$REGION" \
    --instance-ids "$INSTANCE_ID" \
    --document-name "AWS-RunShellScript" \
    --comment "Bootstrap dedicated wine-search-engine app host" \
    --parameters "file://${tmp_bootstrap}" \
    --query 'Command.CommandId' \
    --output text
)"

status=""
for _ in $(seq 1 120); do
  status="$(
    aws ssm get-command-invocation \
      --region "$REGION" \
      --command-id "$command_id" \
      --instance-id "$INSTANCE_ID" \
      --query 'Status' \
      --output text 2>/dev/null || true
  )"
  case "$status" in
    Success) break ;;
    Cancelled|TimedOut|Failed|Cancelling)
      aws ssm get-command-invocation \
        --region "$REGION" \
        --command-id "$command_id" \
        --instance-id "$INSTANCE_ID" \
        --query '{Status:Status,Stdout:StandardOutputContent,Stderr:StandardErrorContent}' \
        --output json
      exit 1
      ;;
  esac
  sleep 5
done

if [[ "$status" != "Success" ]]; then
  echo "Bootstrap command did not reach Success: $command_id" >&2
  exit 1
fi

aws ec2 describe-instances \
  --region "$REGION" \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].{InstanceId:InstanceId,PrivateIpAddress:PrivateIpAddress,PublicIpAddress:PublicIpAddress,SubnetId:SubnetId,VpcId:VpcId,SecurityGroupId:SecurityGroups[0].GroupId,ImageId:ImageId,InstanceType:InstanceType,State:State.Name,IamInstanceProfileArn:IamInstanceProfile.Arn}' \
  --output json
