#!/usr/bin/env bash
# 本地改动 ↔ GitHub 同步，并让 systemd 用户服务加载新代码
set -euo pipefail
set -o errtrace
cd "$(dirname "$0")"

SERVICE="${KAOGONG_SERVICE:-gongkao.service}"
BRANCH="${KAOGONG_BRANCH:-master}"
PORT="${KAOGONG_PORT:-8300}"
LOG="${KAOGONG_SYNC_LOG:-$PWD/sync.log}"
NET_TIMEOUT="${KAOGONG_NET_TIMEOUT:-90}"      # 单条联网命令上限，超时立刻报错而不是无限挂住
PROBE_TIMEOUT="${KAOGONG_PROBE_TIMEOUT:-60}"  # 重启后等待 HTTP 200 的窗口（秒），首次建索引可能很慢
INIT_AT=$SECONDS
SERVICE_OK=1
REPORTED=0

# 低速超过 30s 直接断开：网络卡住时快速失败并给出原因
GIT_NET=(-c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 -c core.pager=cat)
export GIT_TERMINAL_PROMPT=0
export GIT_PAGER=cat
export GIT_PROGRESS_DELAY=0

_emit() {
  local tag="$1" msg="$2" line
  line="[$(date '+%F %T')] ${tag}${msg}"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>"$LOG"
}
log()  { _emit "     " "$*"; }
step() { STEP_T0=$SECONDS; REPORTED=0; _emit "▶    " "$*"; }
done_step() { _emit "✓    " "$*（$((SECONDS - STEP_T0))s）"; }
warn() { _emit "⚠    " "$*"; }
fail() { REPORTED=1; _emit "✗    " "$*"; }

# 执行命令：逐行缩进、实时输出到终端，同时落入日志
run() {
  local rc
  set +e
  "$@" 2>&1 | tr '\r' '\n' | sed -u 's/^/      /' | tee -a "$LOG"
  rc=${PIPESTATUS[0]}
  set -e
  return "$rc"
}

on_exit() {
  local code=$?
  [ "$SERVICE_OK" -eq 1 ] || code=1
  _emit "==   " "结束 | 耗时 $((SECONDS - INIT_AT))s | 退出码 $code"
}
on_err() {
  local code=$?
  [ "$REPORTED" -eq 0 ] || return 0
  fail "命令失败：「$BASH_COMMAND」（退出码 $code），原因见上方输出"
}
trap on_exit EXIT
trap on_err ERR

probe_http() {
  step "HTTP 探测 http://127.0.0.1:$PORT/（最多等 ${PROBE_TIMEOUT}s）"
  local code deadline=$((SECONDS + PROBE_TIMEOUT))
  while :; do
    code=$(curl -sS --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:$PORT/" 2>/dev/null || true)
    if [ "$code" = "200" ]; then
      done_step "服务响应 200（正常）"
      return 0
    fi
    [ "$SECONDS" -lt "$deadline" ] || break
    sleep 1
  done
  SERVICE_OK=0
  fail "等了 ${PROBE_TIMEOUT}s 仍是 ${code:-无响应}：服务未正常对外响应"
  log "若刚升级过版本，首次启动可能要重建搜索索引，可用 KAOGONG_PROBE_TIMEOUT=180 重试"
  log "排查：systemctl --user status $SERVICE -n 50 --no-pager"
}

restart_service() {
  if ! systemctl --user is-active --quiet "$SERVICE"; then
    warn "$SERVICE 未在运行，跳过重启（下次启动自然生效）"
    return 0
  fi
  local old_pid new_pid
  old_pid=$(systemctl --user show -p MainPID --value "$SERVICE" 2>/dev/null || echo '?')
  step "重启 $SERVICE"
  run systemctl --user restart "$SERVICE" || { SERVICE_OK=0; fail "systemctl restart 失败"; return 1; }
  if ! systemctl --user is-active --quiet "$SERVICE"; then
    SERVICE_OK=0
    fail "$SERVICE 重启后未运行，最近 20 行日志："
    systemctl --user status "$SERVICE" --no-pager -n 20 2>&1 | sed 's/^/      /' | tee -a "$LOG" || true
    return 1
  fi
  new_pid=$(systemctl --user show -p MainPID --value "$SERVICE")
  done_step "已重启 $SERVICE（PID $old_pid → $new_pid）"
  probe_http || true
}

# 联网前置检查：把「无限期卡住」变成「90s 内失败并说清原因」
check_network() {
  step "网络预检（代理 / github.com / origin 可达性）"
  local proxy="${https_proxy:-${HTTPS_PROXY:-}}"
  if [ -n "$proxy" ]; then
    log "使用代理 $proxy"
    local code
    code=$(timeout 8 curl -sS -o /dev/null -w '%{http_code}' --max-time 6 https://github.com/ 2>/dev/null || true)
    if [ "$code" != "200" ]; then
      fail "经代理访问 github.com 失败（${code:-无响应}）；代理挂了会让 git 一直挂着"
      log "检查代理进程：ps -ef | grep -iE 'clash|mihomo|v2ray|xray'"
      return 1
    fi
    log "代理可用（github.com → 200）"
  else
    warn "未设置 http(s)_proxy，github 直连在国内通常不通"
  fi
  local ref
  if ! ref=$(timeout "$NET_TIMEOUT" git "${GIT_NET[@]}" ls-remote origin -h "refs/heads/$BRANCH" 2>&1); then
    fail "读取 origin/$BRANCH 失败（上限 ${NET_TIMEOUT}s）：$ref"
    return 1
  fi
  REMOTE_SHA=$(printf '%s' "$ref" | awk '{print substr($1,1,8)}')
  done_step "origin/$BRANCH = ${REMOTE_SHA:-未知}"
}

do_pull() {
  _emit "==   " "pull 开始 | 分支=$BRANCH 服务=$SERVICE | 日志=$LOG"
  before=$(git rev-parse --short HEAD)
  log "本地版本 $before"

  check_network

  step "拉取 origin/$BRANCH 的新提交"
  run timeout "$NET_TIMEOUT" git "${GIT_NET[@]}" fetch --progress --prune origin \
    "+refs/heads/$BRANCH:refs/remotes/origin/$BRANCH" \
    || { SERVICE_OK=0; fail "fetch 失败或超时（上限 ${NET_TIMEOUT}s）"; return 1; }
  done_step "已获取远端引用 origin/$BRANCH = $(git rev-parse --short "origin/$BRANCH")"

  local incoming
  incoming=$(git rev-list --count "HEAD..origin/$BRANCH")
  if [ "$incoming" -eq 0 ]; then
    _emit "✓    " "已是最新 $before，跳过重启"
    return 0
  fi
  log "远端新增 $incoming 个提交："
  git --no-pager log --oneline "HEAD..origin/$BRANCH" | sed 's/^/      /' | tee -a "$LOG"

  step "合入更新（rebase 到 origin/$BRANCH）"
  if ! run git "${GIT_NET[@]}" rebase "origin/$BRANCH"; then
    SERVICE_OK=0
    if [ -d "$(git rev-parse --git-path rebase-merge)" ] || [ -d "$(git rev-parse --git-path rebase-apply)" ]; then
      fail "rebase 冲突，仓库停在半途状态"
      log "处理：解决冲突后 git add -A && git rebase --continue；不想合了用 git rebase --abort"
    elif [ -n "$(git status --porcelain)" ]; then
      fail "本地有未提交改动，无法 rebase"
      log "处理：先 ./sync.sh push \"说明\" 把本地改动提交掉，再 pull"
    else
      fail "rebase 失败，原因见上方输出"
    fi
    return 1
  fi
  after=$(git rev-parse --short HEAD)
  done_step "代码更新 $before → $after"

  restart_service || true
}

do_push() {
  local msg="${1:-}"
  [ -n "$msg" ] || { echo "缺少提交说明"; usage; exit 1; }
  _emit "==   " "push 开始 | 分支=$BRANCH 服务=$SERVICE | 日志=$LOG"

  step "收集改动（git add -A）"
  git add -A
  if git diff --cached --quiet; then
    log "没有需要提交的改动"
    done_step "工作区干净"
  else
    log "本次提交包含的改动："
    git --no-pager diff --cached --stat | sed 's/^/      /' | tee -a "$LOG"
    run git commit -m "$msg" || { SERVICE_OK=0; fail "提交失败"; return 1; }
    done_step "已提交 $(git rev-parse --short HEAD)"
  fi

  step "推送到 origin/$BRANCH"
  run timeout "$NET_TIMEOUT" git "${GIT_NET[@]}" push --progress origin "HEAD:$BRANCH" \
    || { SERVICE_OK=0; fail "推送失败或超时（上限 ${NET_TIMEOUT}s）"; return 1; }
  done_step "推送完成，origin/$BRANCH = $(git rev-parse --short "origin/$BRANCH")"

  restart_service || true
}

usage() {
  cat <<'EOF'
用法:
  ./sync.sh push "提交说明"   提交全部改动 → 推送到 origin → 重启服务
  ./sync.sh pull              拉取远程改动（rebase）→ 重启服务
  ./sync.sh restart           只重启服务（改完 server.py 后让它生效）

环境变量:
  KAOGONG_SERVICE       systemd 用户服务名，默认 gongkao.service
  KAOGONG_BRANCH        分支，默认 master
  KAOGONG_PORT          探测端口，默认 8300
  KAOGONG_SYNC_LOG      日志文件，默认 ./sync.log
  KAOGONG_NET_TIMEOUT   单条联网命令超时秒数，默认 90（卡住时快速失败）
  KAOGONG_PROBE_TIMEOUT 重启后等待 HTTP 200 的秒数，默认 60
EOF
}

case "${1:-}" in
  push)    do_push "${2:-}" ;;
  pull)    do_pull ;;
  restart)
    _emit "==   " "restart 开始 | 服务=$SERVICE | 当前版本=$(git rev-parse --short HEAD)"
    restart_service || true
    ;;
  *)       usage; exit 1 ;;
esac
