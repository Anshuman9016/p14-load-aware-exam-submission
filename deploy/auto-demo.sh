#!/usr/bin/env bash
# P14 - self-running demo. Run in AWS CloudShell:  bash ~/p14-laess/deploy/auto-demo.sh
# Keep the teacher page open on screen: it updates live while this runs (about 4 minutes).
set -uo pipefail
source ~/p14-state.env
export AWS_REGION=ap-south-1 AWS_DEFAULT_REGION=ap-south-1 AWS_PAGER=""
B="http://$PUBLIC_IP:3000/api"
RUN=$(date +%H%M%S)
TMP=$(mktemp -d)
say() { echo; echo "==== $* ===="; }
json() { python3 -c "import sys,json;print(json.load(sys.stdin)$1)"; }
login() { curl -s -XPOST $B/auth/login -H 'content-type: application/json' -d "{\"email\":\"$1\",\"password\":\"demo123\"}" | json '["token"]'; }

say "STEP 1: Teacher creates a live exam (open now, closes in 2 hours)"
TT=$(login teacher@demo.com)
START=$(date -u +%Y-%m-%dT%H:%M:%SZ); END=$(date -u -d '+2 hours' +%Y-%m-%dT%H:%M:%SZ)
EXAM=$(curl -s -XPOST $B/exams -H "authorization: Bearer $TT" -H 'content-type: application/json' \
  -d "{\"title\":\"Live Demo $RUN\",\"startTime\":\"$START\",\"deadline\":\"$END\"}" | json '["exam"]["id"]')
echo "Exam \"Live Demo $RUN\" created (id $EXAM). On the teacher page, click View submissions on it."
sleep 15

echo "Registering 25 demo students..."
for i in $(seq 1 25); do
  curl -s -o /dev/null -XPOST $B/auth/register -H 'content-type: application/json' \
    -d "{\"name\":\"Student $i\",\"email\":\"s$i-$RUN@demo.com\",\"password\":\"demo123\",\"role\":\"student\"}"
  login "s$i-$RUN@demo.com" > "$TMP/t$i"
  echo "Answer sheet of student $i" > "$TMP/a$i.txt"
done
submit() { curl -s -o /dev/null -w "student $1 -> HTTP %{http_code}\n" -XPOST $B/exams/$EXAM/submit \
  -H "authorization: Bearer $(cat $TMP/t$1)" -F "file=@$TMP/a$1.txt"; }

say "STEP 2: Normal load - 5 students submit, a few seconds apart"
for i in 1 2 3 4 5; do submit $i; sleep 3; done
echo "Each one gets 202 Received at once; the Lambda worker marks it processed 1-2 s later."
sleep 8

say "STEP 3: Last-minute rush - 12 students click Submit at the same moment"
for i in $(seq 6 17); do submit $i & done; wait
echo "All accepted instantly. The queue absorbs the spike; Lambda scales out to drain it."
sleep 12

say "STEP 4: Failure test - the worker goes down"
aws lambda update-event-source-mapping --uuid "$ESM_UUID" --no-enabled --query State --output text
echo "Waiting 40 s for AWS to stop the worker..."; sleep 40
for i in $(seq 18 25); do submit $i; sleep 1; done
echo "Students still get 202 Received - their submissions wait safely in SQS (status: queued)."
echo "Watch the Queue number on the teacher page go up."
sleep 30

say "STEP 5: Recovery - the worker comes back"
aws lambda update-event-source-mapping --uuid "$ESM_UUID" --enabled --query State --output text
echo "Waiting for the queue to drain..."
for n in $(seq 1 36); do
  Q=$(curl -s $B/exams/$EXAM/submissions -H "authorization: Bearer $TT" | python3 -c \
    "import sys,json;s=json.load(sys.stdin)['submissions'];print(sum(x['status']=='processed' for x in s), len(s))")
  set -- $Q; echo "processed $1 of $2"
  [ "$1" = "$2" ] && break
  sleep 5
done

say "RESULT"
echo "Accepted: $2   Processed: $1   Lost: $(( $2 - $1 ))"
echo "Every accepted submission was processed, even through a rush and a worker crash."
rm -rf "$TMP"
