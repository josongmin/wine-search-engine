#!/usr/bin/env bash
# Launch (or show) the self-hosted Vespa EC2 instance — t4g.large + public EIP + IP-whitelisted SG.
#
# Usage:
#   MYIP=221.167.246.90/32 bash scripts/vespa-self-host/launch-ec2.sh
#   bash scripts/vespa-self-host/launch-ec2.sh   # auto-detects public IP via checkip.amazonaws.com
#
# After launch:
#   VESPA_CONFIG_URL=http://<EIP>:19071 bash scripts/deploy-vespa.sh
#   VESPA_URL=http://<EIP>:8080 in .env
#
set -euo pipefail

REGION="${AWS_REGION:-ap-northeast-2}"
INSTANCE_TYPE="${VESPA_EC2_INSTANCE_TYPE:-t4g.large}"
AMI_ID="${VESPA_EC2_AMI_ID:-ami-0ca252316919414e7}"
KEY_NAME="${VESPA_EC2_KEY_NAME:-pickinstead_korea.pem}"
VPC_ID="${VESPA_EC2_VPC_ID:-vpc-4340a92a}"
SUBNET_ID="${VESPA_EC2_SUBNET_ID:-subnet-1b1af372}"
SG_NAME="${VESPA_EC2_SG_NAME:-vespa-wine-prod-sg}"
INSTANCE_NAME="${VESPA_EC2_INSTANCE_NAME:-vespa-wine-prod}"
ROOT_VOLUME_GB="${VESPA_EC2_ROOT_VOLUME_GB:-30}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
USERDATA="${SCRIPT_DIR}/vespa-userdata.sh"

if [[ ! -f "$USERDATA" ]]; then
  echo "FATAL: missing $USERDATA" >&2
  exit 1
fi

if [[ -z "${MYIP:-}" ]]; then
  MYIP="$(curl -sf --max-time 10 https://checkip.amazonaws.com)/32"
  echo "[launch] MYIP auto-detected: $MYIP"
fi

existing_id="$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=${INSTANCE_NAME}" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || true)"
if [[ -n "$existing_id" && "$existing_id" != "None" ]]; then
  echo "[launch] Instance already exists: $existing_id ($INSTANCE_NAME)"
  aws ec2 describe-instances --region "$REGION" --instance-ids "$existing_id" \
    --query 'Reservations[0].Instances[0].[InstanceType,State.Name,PublicIpAddress]' --output text
  exit 0
fi

echo "[launch] Creating security group $SG_NAME ..."
SG_ID="$(aws ec2 create-security-group --region "$REGION" \
  --group-name "$SG_NAME" \
  --description "Vespa wine search self-host: SSH+config+search from operator IP only" \
  --vpc-id "$VPC_ID" \
  --query 'GroupId' --output text 2>/dev/null || \
  aws ec2 describe-security-groups --region "$REGION" \
    --filters "Name=group-name,Values=${SG_NAME}" "Name=vpc-id,Values=${VPC_ID}" \
    --query 'SecurityGroups[0].GroupId' --output text)"

for port in 22 8080 19071 19092; do
  aws ec2 authorize-security-group-ingress --region "$REGION" \
    --group-id "$SG_ID" --protocol tcp --port "$port" --cidr "$MYIP" \
    --output text 2>/dev/null || true
done
echo "[launch] SG $SG_ID — ports 22/8080/19071/19092 from $MYIP"

echo "[launch] Running instance ($INSTANCE_TYPE) ..."
INSTANCE_ID="$(aws ec2 run-instances --region "$REGION" \
  --image-id "$AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --key-name "$KEY_NAME" \
  --security-group-ids "$SG_ID" \
  --subnet-id "$SUBNET_ID" \
  --associate-public-ip-address \
  --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=${ROOT_VOLUME_GB},VolumeType=gp3,Iops=3000,Throughput=125,DeleteOnTermination=true}" \
  --user-data "file://${USERDATA}" \
  --metadata-options 'HttpTokens=required,HttpPutResponseHopLimit=2' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${INSTANCE_NAME}},{Key=Purpose,Value=wine-search-self-host}]" \
                       "ResourceType=volume,Tags=[{Key=Name,Value=${INSTANCE_NAME}-root}]" \
  --query 'Instances[0].InstanceId' --output text)"

aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID"

ALLOC="$(aws ec2 allocate-address --region "$REGION" --domain vpc --query '[AllocationId,PublicIp]' --output text)"
ALLOC_ID="${ALLOC%%$'\t'*}"
EIP="${ALLOC##*$'\t'}"
aws ec2 associate-address --region "$REGION" --instance-id "$INSTANCE_ID" --allocation-id "$ALLOC_ID" >/dev/null

echo ""
echo "Vespa EC2 ready"
echo "  instance_id: $INSTANCE_ID"
echo "  type:        $INSTANCE_TYPE"
echo "  eip:         $EIP"
echo "  ssh:         ssh -i <key.pem> ec2-user@$EIP"
echo "  VESPA_URL:   http://$EIP:8080"
echo "  deploy:      VESPA_CONFIG_URL=http://$EIP:19071 bash scripts/deploy-vespa.sh"
