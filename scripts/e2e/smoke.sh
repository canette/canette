# Shared fixture and assertions for the local Kubernetes smoke-test backends.
# The caller provides kube, guest_registry_reachable, step, die, and the cluster settings.
# Every project a run creates has a slug starting with $project_slug, so the
# backends can clean up its namespaces and images by that prefix.

images=(
    canette-api:apps/api/Dockerfile
    canette-ui:apps/ui/Dockerfile
    canette-builder:apps/builder/Dockerfile
    canette-builder-git-init:apps/builder/images/git-init/Dockerfile
    canette-builder-image-build:apps/builder/images/image-build/Dockerfile
    canette-controller:apps/controller/Dockerfile
    canette-logstreamer:apps/logstreamer/Dockerfile
    canette-authgate:apps/authgate/Dockerfile
)

init_smoke_run() {
    run_id="$(openssl rand -hex 4)"
    namespace="canette-e2e-$run_id"
    tag="git-${sha:0:12}-$run_id"
    project_slug="smoke-$run_id"
    app_slug=hello
    app_host="$app_slug-$project_slug.$domain"
    git_host="fixture-git.$namespace.svc.cluster.local"
    marker="canette-e2e-$run_id"
    work="$(mktemp -d "${TMPDIR:-/tmp}/canette-e2e.XXXXXXXX")"
    release_created=false
    project_id=''
    deployment_id=''
    account_created=false
    stage=setup
}

https() {
    local host="$1"
    shift
    curl --silent --show-error --noproxy '*' --connect-timeout 5 --max-time 25 \
        --cacert "$ca" --resolve "$host:443:$node_ip" "$@"
}

api() {
    local method="$1" path="$2" code
    shift 2
    code="$(https "$ui_host" --request "$method" --header "Origin: https://$ui_host" \
        --cookie "$cookie" --cookie-jar "$cookie" --output "$work/response.json" \
        --write-out '%{http_code}' "$@" "https://$ui_host$path")" || return
    if [[ "$code" != 2?? ]]; then
        printf '%s %s returned HTTP %s\n' "$method" "$path" "$code" >&2
        jq -r '[.code, .error, .message] | map(select(type == "string")) | join(" ")' "$work/response.json" >&2 || true
        return 1
    fi
    cat "$work/response.json"
}

post_json() {
    api POST "$1" --header 'Content-Type: application/json' --data-binary @-
}

retry() {
    local timeout="$1"
    shift
    local deadline=$((SECONDS + timeout))
    until "$@"; do
        (( SECONDS < deadline )) || return 1
        sleep 3
    done
}

run_canette_smoke() {
    install_canette
    create_git_fixture
    deploy_fixture_app
}

install_canette() {
    stage=install
    step "Installing Canette in $namespace"
    kube create namespace "$namespace" --dry-run=client -o json |
        jq --arg label "$infra_label" '.metadata.labels[$label] = "run"' | kube create -f -
    release_created=true
    helm --kubeconfig "$kubeconfig" install "$release" "$chart_dir" \
        -n "$namespace" --wait --timeout 8m \
        --set-string "domain=$domain" --set-string "ui.hostname=$ui_host" \
        --set-string "controller.gateway.name=$gateway_name" \
        --set-string "controller.gateway.namespace=$gateway_namespace" \
        --set-string "image.repo=$image_repo" --set-string "image.tag=$tag" \
        --set-string postgres.persistence.size=1Gi --set-string registry.persistence.size=2Gi \
        2>&1 | tee "$work/helm.log"
    kube -n "$namespace" wait '--for=jsonpath={.status.phase}=Bound' \
        pvc/postgres-data pvc/registry-data --timeout=60s

    registry_reachable() {
        [[ "$(https "$registry_host" -o /dev/null -w '%{http_code}' "https://$registry_host/v2/" 2>/dev/null)" == 401 ]]
    }
    retry 90 registry_reachable || die 'The host did not reach the authenticated registry over HTTPS.'
    retry 30 guest_registry_reachable || die 'The Kubernetes node could not resolve or verify the registry HTTPS endpoint.'
    retry 60 api GET /api/v1/signup-settings >/dev/null || die 'The UI HTTPS route did not proxy requests to the API.'
}

create_git_fixture() {
    stage=git-fixture
    step 'Creating a local Git repository and SSH service'
    mkdir "$work/fixture"
    cat >"$work/fixture/Dockerfile" <<'DOCKERFILE'
FROM busybox:1.37.0
COPY index.html /www/index.html
EXPOSE 8080
CMD ["httpd", "-f", "-p", "8080", "-h", "/www"]
DOCKERFILE
    printf '%s\n' "$marker" >"$work/fixture/index.html"
    git -C "$work/fixture" init -q -b main
    git -C "$work/fixture" add Dockerfile index.html
    git -C "$work/fixture" -c user.name='Canette E2E' -c user.email=fixture@example.test \
        -c commit.gpgsign=false commit -qm "Canette E2E fixture $run_id"
    fixture_sha="$(git -C "$work/fixture" rev-parse HEAD)"
    git -C "$work/fixture" bundle create "$work/fixture.bundle" main
    ssh-keygen -q -t ed25519 -N '' -f "$work/ssh-host"
    ssh-keygen -q -t ed25519 -N '' -f "$work/ssh-client"
    awk -v host="[$git_host]:2222" '{print host, $1, $2}' "$work/ssh-host.pub" >"$work/known_hosts"
    kube -n "$namespace" create configmap fixture-repository --from-file="source.bundle=$work/fixture.bundle"
    kube -n "$namespace" create secret generic fixture-ssh \
        --from-file="host=$work/ssh-host" --from-file="authorized_keys=$work/ssh-client.pub"
    kube -n "$namespace" apply -f - <<'YAML'
apiVersion: v1
kind: Service
metadata:
  name: fixture-git
spec:
  selector:
    app: fixture-git
  ports:
    - name: ssh
      port: 2222
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: fixture-git
spec:
  replicas: 1
  selector:
    matchLabels:
      app: fixture-git
  template:
    metadata:
      labels:
        app: fixture-git
    spec:
      automountServiceAccountToken: false
      containers:
        - name: sshd
          image: alpine:3.23
          command:
            - /bin/sh
            - -ec
            - |
              apk add --no-cache git openssh-server
              adduser -D -h /home/git git
              passwd -d git
              mkdir -p /run/sshd
              mkdir -m 700 /home/git/.ssh
              install -m 600 /keys/authorized_keys /home/git/.ssh/authorized_keys
              git clone --bare /fixture/source.bundle /home/git/fixture.git
              chown -R git:git /home/git
              chmod go-w /home/git
              install -m 600 /keys/host /run/fixture-host-key
              exec /usr/sbin/sshd -D -e -f /dev/null -o Port=2222 \
                -o HostKey=/run/fixture-host-key -o AuthorizedKeysFile=.ssh/authorized_keys \
                -o AllowUsers=git -o PermitRootLogin=no -o PasswordAuthentication=no \
                -o KbdInteractiveAuthentication=no -o DisableForwarding=yes \
                -o 'ForceCommand=git upload-pack /home/git/fixture.git'
          readinessProbe:
            tcpSocket:
              port: 2222
          volumeMounts:
            - name: repository
              mountPath: /fixture
              readOnly: true
            - name: keys
              mountPath: /keys
              readOnly: true
      volumes:
        - name: repository
          configMap:
            name: fixture-repository
        - name: keys
          secret:
            secretName: fixture-ssh
YAML
    kube -n "$namespace" rollout status deployment/fixture-git --timeout=180s
}

deploy_fixture_app() {
    stage=canette-api
    step 'Signing in and triggering a Git deployment through the Canette API'
    email="e2e-$run_id@example.test"
    password="Canette!$(openssl rand -hex 16)"
    jq -n --arg email "$email" --arg password "$password" \
        '{name:"Canette E2E",email:$email,password:$password}' | post_json /api/auth/sign-up/email >/dev/null
    account_created=true
    jq -n --arg email "$email" --arg password "$password" \
        '{email:$email,password:$password}' | post_json /api/auth/sign-in/email >/dev/null

    team_id="$(api GET /api/v1/teams | jq -er '.[0].id')"
    project_id="$(jq -n --arg teamId "$team_id" --arg slug "$project_slug" \
        '{teamId:$teamId,name:"Smoke test",slug:$slug}' | post_json /api/v1/projects | jq -er .id)"
    credential_id="$(jq -n --rawfile key "$work/ssh-client" --rawfile hosts "$work/known_hosts" \
        '{name:"Local fixture",provider:"generic",type:"ssh_key",value:$key,sshKnownHosts:$hosts}' |
        post_json "/api/v1/teams/$team_id/credentials" | jq -er .id)"
    git_url="ssh://git@$git_host:2222/home/git/fixture.git"
    app_id="$(jq -n --arg slug "$app_slug" --arg gitUrl "$git_url" --arg credential "$credential_id" \
        '{name:"Hello",slug:$slug,sourceType:"git",deploymentType:"web",gitUrl:$gitUrl,gitBranch:"main",gitCredentialId:$credential,port:8080}' |
        post_json "/api/v1/projects/$project_id/apps" | jq -er .id)"
    deployment_id="$(printf '{}\n' | post_json "/api/v1/apps/$app_id/deployments" | jq -er .id)"

    stage=deployment
    step "Waiting for deployment $deployment_id"
    deadline=$((SECONDS + 420))
    previous=''
    while (( SECONDS < deadline )); do
        api GET "/api/v1/apps/$app_id/deployments" |
            jq -ce --arg id "$deployment_id" '.items[] | select(.id == $id)' >"$work/deployment.json"
        status="$(jq -er .status "$work/deployment.json")"
        if [[ "$status" != "$previous" ]]; then
            printf '  %s\n' "$status"
            previous="$status"
        fi
        case "$status" in
            live) break ;;
            failed|stopped) die "$(jq -r '.errorMessage // .status' "$work/deployment.json")" ;;
        esac
        sleep 3
    done
    [[ "$previous" == live ]] || die 'Deployment did not reach live within seven minutes.'
    digest="$(jq -er --arg sha "$fixture_sha" '
        select(.commitSha == $sha) | .imageDigest | select(test("^sha256:[a-f0-9]{64}$"))
    ' "$work/deployment.json")" || die 'The deployment did not report the fixture commit and a built image digest.'

    stage=https-assertion
    step 'Verifying the workload image and public HTTPS response'
    app_namespace="$(kube get namespace -l "canette.dev/project-id=$project_id" -o json |
        jq -er '.items | select(length == 1) | .[0].metadata.name')"
    kube -n "$app_namespace" get pods -l "canette.dev/deployment=$deployment_id" -o json |
        jq -e --arg image "$registry_host/$project_slug/$app_slug@$digest" '
            any(.items[];
                . as $pod
                | any(.spec.containers[] | select(.image == $image) | .name;
                    . as $name
                    | any($pod.status.containerStatuses[]?;
                        .name == $name and .ready == true and (.imageID | length > 0))))
        ' >/dev/null || die 'No ready pod is running the candidate app image from the bundled registry.'
    live_url="https://$app_host"
    live_url_reported() {
        [[ "$(api GET "/api/v1/apps/$app_id" | jq -r '.liveUrl // ""')" == "$live_url" ]]
    }
    retry 30 live_url_reported || die "Canette did not report the expected live URL $live_url."
    fixture_responds() {
        local body
        body="$(https "$app_host" --fail "$live_url" 2>/dev/null)" && [[ "$body" == "$marker" ]]
    }
    retry 60 fixture_responds || die "HTTPS response never matched the fixture at $live_url."
    printf '\nPASS %s deployed fixture %s at %s\n' "$sha" "$fixture_sha" "$live_url"
}

# run_lifecycle_tests runs the Go lifecycle scenarios (tests/lifecycle) against
# the release the smoke test installed, using its account and Git fixture.
run_lifecycle_tests() {
    stage=lifecycle
    step 'Running the lifecycle scenarios'
    local run_env="$work/lifecycle-env.json"
    jq -n \
        --arg kubeconfig "$kubeconfig" --arg release "$release" --arg releaseNamespace "$namespace" \
        --arg chartDir "$chart_dir" --arg domain "$domain" --arg uiHost "$ui_host" --arg nodeIP "$node_ip" \
        --arg caFile "$ca" --arg email "$email" --arg password "$password" --arg teamID "$team_id" \
        --arg credentialID "$credential_id" --arg gitURL "$git_url" --arg projectSlugPrefix "$project_slug" \
        '$ARGS.named' >"$run_env"
    local args=(test -tags lifecycle -count=1 -timeout "${LIFECYCLE_TIMEOUT:-60m}" -v)
    [[ -z "${LIFECYCLE_RUN:-}" ]] || args+=(-run "$LIFECYCLE_RUN")
    (cd "$repo/tests/lifecycle" && LIFECYCLE_ENV="$run_env" go "${args[@]}" ./...) 2>&1 |
        tee "$work/lifecycle.log"
    printf '\nPASS %s lifecycle scenarios\n' "$sha"
}
