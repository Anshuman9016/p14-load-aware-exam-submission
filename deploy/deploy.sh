#!/usr/bin/env bash
# P14 - deploy everything to AWS (ap-south-1). Run from AWS CloudShell inside the project folder:
#   bash deploy/deploy.sh
# Safe to re-run: finished steps are remembered in ~/p14-state.env and skipped.
# Tear everything down with: bash deploy/teardown.sh
set -euo pipefail

export AWS_REGION=ap-south-1 AWS_DEFAULT_REGION=ap-south-1 AWS_PAGER=""
STATE=~/p14-state.env
touch "$STATE"
# shellcheck disable=SC1090
source "$STATE"
save() { sed -i "/^$1=/d" "$STATE"; echo "$1=$2" >> "$STATE"; export "$1=$2"; }
say() { echo; echo ">>> $*"; }
TAGS="Key=Project,Value=P14"
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
say "AWS account $ACCOUNT, region $AWS_REGION"

# ---------- Network: default VPC ----------
if [ -z "${VPC_ID:-}" ]; then
  VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
  [ "$VPC" = "None" ] && { echo "No default VPC in ap-south-1. Create one: aws ec2 create-default-vpc"; exit 1; }
  save VPC_ID "$VPC"
fi
if [ -z "${SUBNETS:-}" ]; then
  save SUBNETS "$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC_ID Name=default-for-az,Values=true \
    --query 'Subnets[].SubnetId' --output text | tr '\t' ',')"
fi
say "VPC $VPC_ID, subnets $SUBNETS"

mk_sg() { # name description
  local id
  id=$(aws ec2 describe-security-groups --filters Name=vpc-id,Values=$VPC_ID Name=group-name,Values=$1 \
       --query 'SecurityGroups[0].GroupId' --output text)
  if [ "$id" = "None" ]; then
    id=$(aws ec2 create-security-group --group-name "$1" --description "$2" --vpc-id "$VPC_ID" \
         --tag-specifications "ResourceType=security-group,Tags=[{$TAGS}]" --query GroupId --output text)
  fi
  echo "$id"
}
if [ -z "${SG_API:-}" ]; then
  save SG_API "$(mk_sg p14-api 'P14 API on EC2 - port 3000')"
  aws ec2 authorize-security-group-ingress --group-id "$SG_API" --protocol tcp --port 3000 --cidr 0.0.0.0/0 >/dev/null 2>&1 || true
fi
[ -z "${SG_LAMBDA:-}" ] && save SG_LAMBDA "$(mk_sg p14-lambda 'P14 Lambda worker')"
if [ -z "${SG_DB:-}" ]; then
  save SG_DB "$(mk_sg p14-db 'P14 RDS PostgreSQL')"
  aws ec2 authorize-security-group-ingress --group-id "$SG_DB" \
    --ip-permissions "IpProtocol=tcp,FromPort=5432,ToPort=5432,UserIdGroupPairs=[{GroupId=$SG_API},{GroupId=$SG_LAMBDA}]" >/dev/null 2>&1 || true
fi
say "Security groups: api=$SG_API lambda=$SG_LAMBDA db=$SG_DB"

# ---------- RDS PostgreSQL (started first: it takes the longest) ----------
[ -z "${DB_PASSWORD:-}" ] && save DB_PASSWORD "$(openssl rand -hex 16)"
if [ -z "${DB_STARTED:-}" ]; then
  say "Creating RDS PostgreSQL db.t3.micro (takes 5-10 minutes)"
  aws rds create-db-subnet-group --db-subnet-group-name p14-db-subnets \
    --db-subnet-group-description "P14" --subnet-ids ${SUBNETS//,/ } --tags $TAGS >/dev/null 2>&1 || true
  aws rds create-db-instance --db-instance-identifier p14-db --engine postgres \
    --db-instance-class db.t3.micro --allocated-storage 20 --storage-type gp2 \
    --master-username p14admin --master-user-password "$DB_PASSWORD" --db-name p14 \
    --vpc-security-group-ids "$SG_DB" --db-subnet-group-name p14-db-subnets \
    --no-publicly-accessible --backup-retention-period 0 --no-multi-az --no-deletion-protection \
    --tags $TAGS >/dev/null
  save DB_STARTED 1
fi

# ---------- S3 bucket ----------
if [ -z "${BUCKET:-}" ]; then
  B="p14-submissions-$ACCOUNT"
  aws s3api create-bucket --bucket "$B" --create-bucket-configuration LocationConstraint=$AWS_REGION >/dev/null 2>&1 || true
  aws s3api put-public-access-block --bucket "$B" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-tagging --bucket "$B" --tagging "TagSet=[{$TAGS}]"
  save BUCKET "$B"
fi
say "S3 bucket $BUCKET (private)"

# ---------- SQS queue + dead-letter queue ----------
if [ -z "${QUEUE_URL:-}" ]; then
  DLQ_URL=$(aws sqs create-queue --queue-name p14-dlq --attributes MessageRetentionPeriod=1209600 \
            --tags Project=P14 --query QueueUrl --output text)
  DLQ_ARN=$(aws sqs get-queue-attributes --queue-url "$DLQ_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)
  cat > /tmp/q.json <<EOF
{"VisibilityTimeout":"60","MessageRetentionPeriod":"345600",
 "RedrivePolicy":"{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"5\"}"}
EOF
  Q=$(aws sqs create-queue --queue-name p14-submissions --attributes file:///tmp/q.json --tags Project=P14 --query QueueUrl --output text)
  save DLQ_URL "$DLQ_URL"; save DLQ_ARN "$DLQ_ARN"; save QUEUE_URL "$Q"
  save QUEUE_ARN "$(aws sqs get-queue-attributes --queue-url "$Q" --attribute-names QueueArn --query Attributes.QueueArn --output text)"
fi
say "SQS queue $QUEUE_URL (+ dead-letter queue, 5 tries)"

# ---------- S3 gateway endpoint (so the Lambda in the VPC reaches S3 without a NAT gateway) ----------
if [ -z "${S3_ENDPOINT:-}" ]; then
  RTS=$(aws ec2 describe-route-tables --filters Name=vpc-id,Values=$VPC_ID --query 'RouteTables[].RouteTableId' --output text)
  EP=$(aws ec2 describe-vpc-endpoints --filters Name=vpc-id,Values=$VPC_ID Name=service-name,Values=com.amazonaws.$AWS_REGION.s3 \
       --query 'VpcEndpoints[0].VpcEndpointId' --output text)
  if [ "$EP" = "None" ]; then
    EP=$(aws ec2 create-vpc-endpoint --vpc-id "$VPC_ID" --service-name com.amazonaws.$AWS_REGION.s3 \
         --vpc-endpoint-type Gateway --route-table-ids $RTS \
         --tag-specifications "ResourceType=vpc-endpoint,Tags=[{$TAGS}]" --query VpcEndpoint.VpcEndpointId --output text)
    save S3_ENDPOINT_CREATED 1
  fi
  save S3_ENDPOINT "$EP"
fi
say "S3 gateway endpoint $S3_ENDPOINT (free)"

# ---------- IAM roles ----------
if [ -z "${IAM_DONE:-}" ]; then
  say "Creating IAM roles"
  cat > /tmp/ec2-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
  cat > /tmp/lambda-trust.json <<'EOF'
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}
EOF
  cat > /tmp/ec2-policy.json <<EOF
{"Version":"2012-10-17","Statement":[
 {"Effect":"Allow","Action":["s3:PutObject","s3:GetObject","s3:DeleteObject"],"Resource":"arn:aws:s3:::$BUCKET/*"},
 {"Effect":"Allow","Action":["sqs:SendMessage","sqs:GetQueueAttributes"],"Resource":"$QUEUE_ARN"}]}
EOF
  cat > /tmp/lambda-policy.json <<EOF
{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject"],"Resource":"arn:aws:s3:::$BUCKET/*"}]}
EOF
  aws iam create-role --role-name p14-ec2-role --assume-role-policy-document file:///tmp/ec2-trust.json --tags $TAGS >/dev/null 2>&1 || true
  aws iam attach-role-policy --role-name p14-ec2-role --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
  aws iam put-role-policy --role-name p14-ec2-role --policy-name p14-app --policy-document file:///tmp/ec2-policy.json
  aws iam create-instance-profile --instance-profile-name p14-ec2-profile >/dev/null 2>&1 || true
  aws iam add-role-to-instance-profile --instance-profile-name p14-ec2-profile --role-name p14-ec2-role 2>/dev/null || true

  aws iam create-role --role-name p14-lambda-role --assume-role-policy-document file:///tmp/lambda-trust.json --tags $TAGS >/dev/null 2>&1 || true
  aws iam attach-role-policy --role-name p14-lambda-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole
  aws iam attach-role-policy --role-name p14-lambda-role --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole
  aws iam put-role-policy --role-name p14-lambda-role --policy-name p14-s3-read --policy-document file:///tmp/lambda-policy.json
  echo "Waiting 15 s for IAM to propagate..."; sleep 15
  save IAM_DONE 1
fi

# ---------- Upload the app code to S3 (EC2 downloads it from there) ----------
say "Packaging app code"
cd "$APP_DIR"
rm -f /tmp/p14-app.zip
zip -qr /tmp/p14-app.zip . -x 'node_modules/*' '.env' '.demo-db/*' 'local-storage/*' '.git/*'
aws s3 cp /tmp/p14-app.zip "s3://$BUCKET/deploy/p14-app.zip" --quiet

# ---------- Wait for RDS ----------
say "Waiting for RDS to become available (can take up to 10 minutes)..."
aws rds wait db-instance-available --db-instance-identifier p14-db
save DB_HOST "$(aws rds describe-db-instances --db-instance-identifier p14-db --query 'DBInstances[0].Endpoint.Address' --output text)"
save DATABASE_URL "postgres://p14admin:$DB_PASSWORD@$DB_HOST:5432/p14"
say "RDS ready at $DB_HOST"

# ---------- Lambda worker ----------
if [ -z "${LAMBDA_DONE:-}" ]; then
  say "Building and deploying the Lambda worker"
  rm -rf /tmp/p14-lambda && mkdir -p /tmp/p14-lambda
  cp -r src worker package.json /tmp/p14-lambda/; [ -f package-lock.json ] && cp package-lock.json /tmp/p14-lambda/
  (cd /tmp/p14-lambda && npm install --omit=dev --no-audit --no-fund --silent && rm -f /tmp/p14-worker.zip && zip -qr /tmp/p14-worker.zip .)
  aws lambda create-function --function-name p14-worker --runtime nodejs20.x \
    --handler worker/handler.handler --zip-file fileb:///tmp/p14-worker.zip \
    --role "arn:aws:iam::$ACCOUNT:role/p14-lambda-role" --timeout 30 --memory-size 256 \
    --vpc-config "SubnetIds=$SUBNETS,SecurityGroupIds=$SG_LAMBDA" \
    --environment "Variables={MODE=aws,DATABASE_URL=$DATABASE_URL,DB_SSL=true,S3_BUCKET=$BUCKET,MAX_RECEIVE_COUNT=5}" \
    --tags Project=P14 >/dev/null
  echo "Waiting for the Lambda to become active (VPC setup ~1-2 min)..."
  aws lambda wait function-active-v2 --function-name p14-worker
  save LAMBDA_DONE 1
fi
if [ -z "${ESM_UUID:-}" ]; then
  save ESM_UUID "$(aws lambda create-event-source-mapping --function-name p14-worker --event-source-arn "$QUEUE_ARN" \
    --batch-size 10 --function-response-types ReportBatchItemFailures \
    --scaling-config MaximumConcurrency=10 --query UUID --output text)"
fi
say "Lambda p14-worker connected to SQS (max concurrency 10)"

# ---------- CloudWatch alarm on the dead-letter queue ----------
if [ -z "${ALARM_DONE:-}" ]; then
  aws cloudwatch put-metric-alarm --alarm-name p14-dlq-not-empty \
    --alarm-description "P14: a submission failed 5 times and is in the dead-letter queue" \
    --namespace AWS/SQS --metric-name ApproximateNumberOfMessagesVisible \
    --dimensions Name=QueueName,Value=p14-dlq --statistic Maximum --period 60 \
    --evaluation-periods 1 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
    --treat-missing-data notBreaching --tags $TAGS
  save ALARM_DONE 1
fi
say "CloudWatch alarm p14-dlq-not-empty created"

# ---------- EC2 API server ----------
[ -z "${JWT_SECRET:-}" ] && save JWT_SECRET "$(openssl rand -hex 32)"
if [ -z "${INSTANCE_ID:-}" ]; then
  say "Launching EC2 t3.micro for the API"
  AMI=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64 --query Parameter.Value --output text)
  cat > /tmp/userdata.sh <<EOF
#!/bin/bash
set -ex
exec > /var/log/p14-setup.log 2>&1
dnf install -y nodejs npm unzip
npm install -g pm2
mkdir -p /opt/p14 && cd /opt/p14
aws s3 cp s3://$BUCKET/deploy/p14-app.zip /tmp/app.zip --region $AWS_REGION
unzip -o /tmp/app.zip -d /opt/p14
cat > /opt/p14/.env <<ENV
MODE=aws
PORT=3000
JWT_SECRET=$JWT_SECRET
DATABASE_URL=$DATABASE_URL
DB_SSL=true
RATE_LIMIT_PER_MIN=5
BUSY_THRESHOLD=500
OVERLOAD_THRESHOLD=2000
RETRY_AFTER_SECONDS=15
MAX_RECEIVE_COUNT=5
AWS_REGION=$AWS_REGION
S3_BUCKET=$BUCKET
SQS_QUEUE_URL=$QUEUE_URL
ENV
chmod 600 /opt/p14/.env
npm install --omit=dev --no-audit --no-fund
npm run migrate
npm run seed
export HOME=/root
pm2 start ecosystem.config.js
pm2 save
pm2 startup systemd -u root --hp /root
echo P14_SETUP_DONE
EOF
  save INSTANCE_ID "$(aws ec2 run-instances --image-id "$AMI" --instance-type t3.micro \
    --subnet-id "${SUBNETS%%,*}" --security-group-ids "$SG_API" \
    --iam-instance-profile Name=p14-ec2-profile --associate-public-ip-address \
    --metadata-options HttpTokens=required \
    --user-data file:///tmp/userdata.sh \
    --tag-specifications "ResourceType=instance,Tags=[{$TAGS},{Key=Name,Value=p14-api}]" \
                         "ResourceType=volume,Tags=[{$TAGS}]" \
    --query 'Instances[0].InstanceId' --output text)"
fi
aws ec2 wait instance-running --instance-ids "$INSTANCE_ID"
save PUBLIC_IP "$(aws ec2 describe-instances --instance-ids "$INSTANCE_ID" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"

say "Waiting for the API to install and start on EC2 (2-4 minutes)..."
for i in $(seq 1 60); do
  if curl -s --max-time 3 "http://$PUBLIC_IP:3000/api/health" | grep -q '"ok":true'; then break; fi
  sleep 6
done
curl -s --max-time 5 "http://$PUBLIC_IP:3000/api/health" || { echo "API not answering yet - check: aws ssm start-session or /var/log/p14-setup.log"; exit 1; }

echo
echo "================================================================"
echo "  DONE. Open:  http://$PUBLIC_IP:3000"
echo "  Teacher : teacher@demo.com  / demo123"
echo "  Students: student1@demo.com / demo123 (also student2, student3)"
echo "  Everything is tagged Project=P14. To delete it all:"
echo "    bash deploy/teardown.sh"
echo "================================================================"
