#!/usr/bin/env bash
# P14 - delete EVERYTHING deploy.sh created, so nothing keeps costing money.
#   bash deploy/teardown.sh
# Safe to re-run if something was still being deleted.
set -uo pipefail
export AWS_REGION=ap-south-1 AWS_DEFAULT_REGION=ap-south-1 AWS_PAGER=""
STATE=~/p14-state.env
# shellcheck disable=SC1090
[ -f "$STATE" ] && source "$STATE"
say() { echo; echo ">>> $*"; }
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
BUCKET=${BUCKET:-p14-submissions-$ACCOUNT}

say "Deleting Lambda trigger and function"
for u in $(aws lambda list-event-source-mappings --function-name p14-worker --query 'EventSourceMappings[].UUID' --output text 2>/dev/null); do
  aws lambda delete-event-source-mapping --uuid "$u" >/dev/null
done
aws lambda delete-function --function-name p14-worker 2>/dev/null && echo "  p14-worker deleted"
aws logs delete-log-group --log-group-name /aws/lambda/p14-worker 2>/dev/null

say "Terminating EC2 instance(s)"
IDS=$(aws ec2 describe-instances --filters Name=tag:Project,Values=P14 Name=instance-state-name,Values=pending,running,stopping,stopped \
      --query 'Reservations[].Instances[].InstanceId' --output text)
if [ -n "$IDS" ]; then
  aws ec2 terminate-instances --instance-ids $IDS >/dev/null
  echo "  waiting for $IDS to terminate..."; aws ec2 wait instance-terminated --instance-ids $IDS
fi

say "Deleting RDS database (no final snapshot) - takes a few minutes"
if aws rds describe-db-instances --db-instance-identifier p14-db >/dev/null 2>&1; then
  aws rds delete-db-instance --db-instance-identifier p14-db --skip-final-snapshot --delete-automated-backups >/dev/null 2>&1
  aws rds wait db-instance-deleted --db-instance-identifier p14-db
fi
aws rds delete-db-subnet-group --db-subnet-group-name p14-db-subnets 2>/dev/null

say "Deleting SQS queues"
for q in p14-submissions p14-dlq; do
  url=$(aws sqs get-queue-url --queue-name $q --query QueueUrl --output text 2>/dev/null) && aws sqs delete-queue --queue-url "$url" && echo "  $q deleted"
done

say "Emptying and deleting S3 bucket $BUCKET"
if aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
  aws s3 rm "s3://$BUCKET" --recursive --quiet
  aws s3api delete-bucket --bucket "$BUCKET" && echo "  bucket deleted"
fi

say "Deleting CloudWatch alarm"
aws cloudwatch delete-alarms --alarm-names p14-dlq-not-empty

if [ "${S3_ENDPOINT_CREATED:-}" = "1" ] && [ -n "${S3_ENDPOINT:-}" ]; then
  say "Deleting S3 gateway endpoint"
  aws ec2 delete-vpc-endpoints --vpc-endpoint-ids "$S3_ENDPOINT" >/dev/null
fi

say "Deleting IAM roles"
aws iam remove-role-from-instance-profile --instance-profile-name p14-ec2-profile --role-name p14-ec2-role 2>/dev/null
aws iam delete-instance-profile --instance-profile-name p14-ec2-profile 2>/dev/null
aws iam detach-role-policy --role-name p14-ec2-role --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore 2>/dev/null
aws iam delete-role-policy --role-name p14-ec2-role --policy-name p14-app 2>/dev/null
aws iam delete-role --role-name p14-ec2-role 2>/dev/null
for p in service-role/AWSLambdaVPCAccessExecutionRole service-role/AWSLambdaSQSQueueExecutionRole; do
  aws iam detach-role-policy --role-name p14-lambda-role --policy-arn arn:aws:iam::aws:policy/$p 2>/dev/null
done
aws iam delete-role-policy --role-name p14-lambda-role --policy-name p14-s3-read 2>/dev/null
aws iam delete-role --role-name p14-lambda-role 2>/dev/null

say "Deleting security groups (Lambda network interfaces can take up to ~20 min to be released by AWS)"
VPC_ID=${VPC_ID:-$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)}
for name in p14-db p14-api p14-lambda; do
  id=$(aws ec2 describe-security-groups --filters Name=vpc-id,Values=$VPC_ID Name=group-name,Values=$name --query 'SecurityGroups[0].GroupId' --output text)
  [ "$id" = "None" ] && continue
  for i in $(seq 1 40); do
    if aws ec2 delete-security-group --group-id "$id" 2>/dev/null; then echo "  $name deleted"; break; fi
    [ "$i" = 1 ] && echo "  $name still in use, retrying every 30 s..."
    sleep 30
  done
done

say "Checking for anything left with tag Project=P14"
LEFT=$(aws resourcegroupstaggingapi get-resources --tag-filters Key=Project,Values=P14 --query 'ResourceTagMappingList[].ResourceARN' --output text)
if [ -z "$LEFT" ]; then
  echo "  Nothing left. All P14 resources are deleted."
  rm -f "$STATE"
else
  echo "  Still listed (some may just be finishing deletion - re-run this script in a few minutes):"
  echo "$LEFT" | tr '\t' '\n' | sed 's/^/    /'
fi
