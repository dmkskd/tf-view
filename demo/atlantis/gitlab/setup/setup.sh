#!/usr/bin/env bash
# One-shot GitLab setup for the Atlantis demo. Safe to re-run: skips what already exists.
set -euo pipefail
GL=http://localhost:8929
ROOT_PW=demo-password-123
ENVFILE=/shared/atlantis.env

# 1+2+3. Token for Atlantis, created inside GitLab (the OAuth password grant no longer exists), and
# webhooks allowed to reach local addresses (GitLab blocks them by default). The token and the webhook
# secret are handed to Atlantis through the shared volume.
if [ ! -f "$ENVFILE" ]; then
  TOKEN="glpat-demo$(head -c12 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  SECRET=$(head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')
  GLC=$(docker ps -q --filter label=com.docker.compose.service=gitlab --filter label=com.docker.compose.project="$COMPOSE_PROJECT" | head -1)
  [ -n "$GLC" ] || { echo "gitlab container not found"; exit 1; }
  docker exec "$GLC" gitlab-rails runner "
    u = User.find_by_username('root')
    t = u.personal_access_tokens.build(name: 'atlantis', scopes: [:api], expires_at: 300.days.from_now)
    t.set_token('$TOKEN'); t.save!
    ApplicationSetting.current.update!(allow_local_requests_from_web_hooks_and_services: true)
  "
  printf 'export ATLANTIS_GITLAB_TOKEN=%s\nexport ATLANTIS_GITLAB_WEBHOOK_SECRET=%s\n' "$TOKEN" "$SECRET" > "$ENVFILE"
  chmod 644 "$ENVFILE"
  echo "created token + webhook secret"
fi
. "$ENVFILE"; TOKEN=$ATLANTIS_GITLAB_TOKEN; SECRET=$ATLANTIS_GITLAB_WEBHOOK_SECRET
api() { curl -fsS -H "PRIVATE-TOKEN: $TOKEN" "$@"; }

# Terraform state bucket in Floci (state must outlive each MR's working directory to get real diffs)
curl -fsS -X PUT http://floci:4566/tfstate >/dev/null && echo "state bucket ready"

# 4. project, webhook and initial commit
if api "$GL/api/v4/projects/root%2Fdemo-infra" >/dev/null 2>&1; then
  echo "project root/demo-infra already exists"
  # keep main in step with the seed files, so `just up` picks up changes to infra/
  P="$GL/api/v4/projects/root%2Fdemo-infra"; ACTIONS='[]'
  for f in $(cd /seed && find infra atlantis.yaml -type f); do
    if cur=$(api "$P/repository/files/$(jq -rn --arg f "$f" '$f|@uri')/raw?ref=main" 2>/dev/null); then
      [ "$cur" = "$(cat /seed/$f)" ] && continue; act=update
    else act=create; fi
    ACTIONS=$(jq --arg a "$act" --arg f "$f" --rawfile c "/seed/$f" '. + [{action:$a,file_path:$f,content:$c}]' <<<"$ACTIONS")
  done
  if [ "$ACTIONS" != '[]' ]; then
    api -X POST "$P/repository/commits" -H 'Content-Type: application/json' \
      -d "$(jq -n --argjson a "$ACTIONS" '{branch:"main",commit_message:"sync demo infra",actions:$a}')" >/dev/null
    echo "synced changed infra files to main"
  fi
else
  PID=$(api -X POST "$GL/api/v4/projects" -d name=demo-infra -d visibility=private | jq -r .id)
  # the web process can take a moment to pick up the allow-local-requests setting (422 until then)
  for i in 1 2 3 4 5 6; do
    api -X POST "$GL/api/v4/projects/$PID/hooks" \
      -d url=http://localhost:4141/events -d token="$SECRET" \
      -d merge_requests_events=true -d note_events=true -d push_events=true \
      -d enable_ssl_verification=false >/dev/null && break
    [ "$i" = 6 ] && { echo "webhook creation failed"; exit 1; }
    sleep 10
  done
  W=$(mktemp -d); cp -R /seed/infra /seed/atlantis.yaml "$W"/
  ( cd "$W" && git init -q -b main && git add -A \
    && git -c user.name=demo -c user.email=demo@example.com commit -qm "initial infra" \
    && git push -q "http://root:$TOKEN@localhost:8929/root/demo-infra.git" main )
  echo "created project root/demo-infra"
fi
echo "setup done: GitLab $GL (root / $ROOT_PW), Atlantis http://localhost:4141, reports http://localhost:8080"
