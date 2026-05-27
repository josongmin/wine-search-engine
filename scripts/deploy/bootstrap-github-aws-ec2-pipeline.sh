#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bootstrap-github-aws-ec2-pipeline.sh \
    --instance-id i-abc123 \
    [--region ap-northeast-2] \
    [--role-name github-actions-wine-search-engine-deploy] \
    [--ecr-repo wine-search-engine] \
    [--container-name wine-search-engine] \
    [--host-port 4000] \
    [--app-port 3000] \
    [--env-file /etc/wine-search-engine.env] \
    [--health-path /ready]
EOF
}

INSTANCE_ID=""
REGION="${AWS_REGION:-ap-northeast-2}"
ROLE_NAME="github-actions-wine-search-engine-deploy"
ECR_REPO="wine-search-engine"
CONTAINER_NAME="wine-search-engine"
HOST_PORT="4000"
APP_PORT="3000"
ENV_FILE="/etc/wine-search-engine.env"
HEALTH_PATH="/ready"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --instance-id) INSTANCE_ID="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --role-name) ROLE_NAME="$2"; shift 2 ;;
    --ecr-repo) ECR_REPO="$2"; shift 2 ;;
    --container-name) CONTAINER_NAME="$2"; shift 2 ;;
    --host-port) HOST_PORT="$2"; shift 2 ;;
    --app-port) APP_PORT="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --health-path) HEALTH_PATH="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

if [[ -z "$INSTANCE_ID" ]]; then
  echo "Missing required --instance-id" >&2
  usage
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh CLI is required" >&2
  exit 1
fi

repo_slug="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
account_id="$(aws sts get-caller-identity --query Account --output text)"
provider_arn="arn:aws:iam::${account_id}:oidc-provider/token.actions.githubusercontent.com"
role_arn="arn:aws:iam::${account_id}:role/${ROLE_NAME}"
repo_arn="arn:aws:ecr:${REGION}:${account_id}:repository/${ECR_REPO}"
instance_arn="arn:aws:ec2:${REGION}:${account_id}:instance/${INSTANCE_ID}"
document_arn="arn:aws:ssm:${REGION}::document/AWS-RunShellScript"

if ! aws iam get-open-id-connect-provider --open-id-connect-provider-arn "$provider_arn" >/dev/null 2>&1; then
  aws iam create-open-id-connect-provider \
    --url https://token.actions.githubusercontent.com \
    --client-id-list sts.amazonaws.com \
    --thumbprint-list 6938fd4d98bab03faadb97b34396831e3780aea1 >/dev/null
fi

aws ecr describe-repositories --region "$REGION" --repository-names "$ECR_REPO" >/dev/null 2>&1 || \
  aws ecr create-repository --region "$REGION" --repository-name "$ECR_REPO" >/dev/null

trust_policy="$(mktemp)"
policy_doc="$(mktemp)"
trap 'rm -f "$trust_policy" "$policy_doc"' EXIT

cat > "$trust_policy" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "${provider_arn}"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
        },
        "StringLike": {
          "token.actions.githubusercontent.com:sub": [
            "repo:${repo_slug}:ref:refs/heads/main"
          ]
        }
      }
    }
  ]
}
EOF

cat > "$policy_doc" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "EcrAuth",
      "Effect": "Allow",
      "Action": [
        "ecr:GetAuthorizationToken"
      ],
      "Resource": "*"
    },
    {
      "Sid": "EcrPush",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability",
        "ecr:CompleteLayerUpload",
        "ecr:DescribeImages",
        "ecr:DescribeRepositories",
        "ecr:InitiateLayerUpload",
        "ecr:PutImage",
        "ecr:UploadLayerPart"
      ],
      "Resource": "${repo_arn}"
    },
    {
      "Sid": "SendSsmDeployCommand",
      "Effect": "Allow",
      "Action": [
        "ssm:SendCommand"
      ],
      "Resource": [
        "${instance_arn}",
        "${document_arn}"
      ]
    },
    {
      "Sid": "ReadDeployState",
      "Effect": "Allow",
      "Action": [
        "ssm:GetCommandInvocation",
        "ssm:ListCommandInvocations",
        "ssm:ListCommands",
        "ec2:DescribeInstances"
      ],
      "Resource": "*"
    }
  ]
}
EOF

if aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam update-assume-role-policy --role-name "$ROLE_NAME" --policy-document "file://${trust_policy}" >/dev/null
else
  aws iam create-role --role-name "$ROLE_NAME" --assume-role-policy-document "file://${trust_policy}" >/dev/null
fi

aws iam put-role-policy \
  --role-name "$ROLE_NAME" \
  --policy-name "${ROLE_NAME}-inline" \
  --policy-document "file://${policy_doc}" >/dev/null

instance_profile_name="$(
  aws ec2 describe-instances \
    --region "$REGION" \
    --instance-ids "$INSTANCE_ID" \
    --query 'Reservations[0].Instances[0].IamInstanceProfile.Arn' \
    --output text | awk -F'/' '{print $NF}'
)"

instance_role_name=""
if [[ -n "$instance_profile_name" && "$instance_profile_name" != "None" ]]; then
  instance_role_name="$(
    aws iam get-instance-profile \
      --instance-profile-name "$instance_profile_name" \
      --query 'InstanceProfile.Roles[0].RoleName' \
      --output text
  )"
fi

if [[ -n "$instance_role_name" && "$instance_role_name" != "None" ]]; then
  aws iam attach-role-policy \
    --role-name "$instance_role_name" \
    --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly >/dev/null 2>&1 || true
fi

gh variable set AWS_REGION --body "$REGION"
gh variable set AWS_DEPLOY_ROLE_ARN --body "$role_arn"
gh variable set DEPLOY_ECR_REPOSITORY --body "$ECR_REPO"
gh variable set DEPLOY_EC2_INSTANCE_ID --body "$INSTANCE_ID"
gh variable set DEPLOY_CONTAINER_NAME --body "$CONTAINER_NAME"
gh variable set DEPLOY_HOST_PORT --body "$HOST_PORT"
gh variable set DEPLOY_APP_PORT --body "$APP_PORT"
gh variable set DEPLOY_ENV_FILE --body "$ENV_FILE"
gh variable set DEPLOY_HEALTH_PATH --body "$HEALTH_PATH"

cat <<EOF
Bootstrap complete.

- repo: ${repo_slug}
- region: ${REGION}
- deploy role: ${role_arn}
- ecr repo: ${ECR_REPO}
- instance: ${INSTANCE_ID}
- instance profile: ${instance_profile_name}
- instance role: ${instance_role_name}

GitHub repo variables set:
- AWS_REGION
- AWS_DEPLOY_ROLE_ARN
- DEPLOY_ECR_REPOSITORY
- DEPLOY_EC2_INSTANCE_ID
- DEPLOY_CONTAINER_NAME
- DEPLOY_HOST_PORT
- DEPLOY_APP_PORT
- DEPLOY_ENV_FILE
- DEPLOY_HEALTH_PATH

Next:
1. Ensure ${ENV_FILE} exists on the host with real runtime secrets.
2. Push to main or run the "Deploy Production" workflow manually.
EOF
