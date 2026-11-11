#!/usr/bin/env bash
# 本地改动 ↔ GitHub 同步，并让 systemd 用户服务加载新代码
set -euo pipefail
set -o errtrace
cd "$(dirname "$0")"

SERVICE="${KAOGONG_SERVICE:-gongkao.service}"
BRANCH="${KAOGONG_BRANCH:-master}"
PORT="${KAOGONG_PORT:-8300}"
LOG="${KAOGONG_SYNC_LOG:-$PWD/sync.log}"

log() {
  local line
  line="[$(date '+%F %T')] $*"
  printf '%s\n' "$line"
  printf '%s\n' "$line" >>"$LOG"
}

run() { "$@" 2>&1 | tee -a "$LOG"; }

trap 'log "✗ 中断（命令: $BASH_COMMAND，退出码 $?）"' ERR

probe_http() {
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$PORT/" 2>/dev/null || true)
  if [ "$code" = "200" ]; then
    log "HTTP 探测 127.0.0.1:$PORT → 200（正常）"
  else
    log "HTTP 探测 127.0.0.1:$PORT → ${code:-无响应}（异常，查看 journalctl --user -u $SERVICE -n 50）"
  fi
}

restart_service() {
  if ! systemctl --user is-active --quiet "$SERVICE"; then
    log "$SERVICE 未在运行，跳过重启（下次启动自然生效）"
    return 0
  fi
  log "重启 $SERVICE ..."
  systemctl --user restart "$SERVICE"
  sleep 2
  if systemctl --user is-active --quiet "$SERVICE"; then
    log "已重启 $SERVICE（PID $(systemctl --user show -p MainPID --value "$SERVICE")）"
    probe_http
  else
    log "✗ $SERVICE 重启后未处于运行状态，最近 15 行日志："
    systemctl --user status "$SERVICE" --no-pager -n 15 2>&1 | tee -a "$LOG" || true
    return 1
  fi
}

usage() {
  cat <<'EOF'
用法:
  ./sync.sh push "提交说明"   提交全部改动 → 推送到 origin → 重启服务
  ./sync.sh pull              拉取远程改动（rebase）→ 重启服务
  ./sync.sh restart           只重启服务（改完 server.py 后让它生效）

环境变量: KAOGONG_SERVICE（默认 gongkao.service）、KAOGONG_BRANCH（默认 master）、
          KAOGONG_PORT（默认 8300，用于重启后 HTTP 探测）、KAOGONG_SYNC_LOG（默认 ./sync.log）
EOF
}

case "${1:-}" in
  push)
    msg="${2:-}"
    [ -n "$msg" ] || { echo "缺少提交说明"; usage; exit 1; }
    log "== push 开始 | 分支=$BRANCH 服务=$SERVICE 日志=$LOG =="
    git add -A
    if git diff --cached --quiet; then
      log "没有需要提交的改动"
    else
      log "本次提交包含的改动："
      run git --no-pager diff --cached --stat
      run git commit -m "$msg"
      log "已提交 $(git rev-parse --short HEAD)"
    fi
    log "推送到 origin/$BRANCH ..."
    run git push origin "HEAD:$BRANCH"
    log "推送完成，origin/$BRANCH 当前为 $(git rev-parse --short origin/$BRANCH)"
    restart_service
    ;;
  pull)
    log "== pull 开始 | 分支=$BRANCH 服务=$SERVICE 日志=$LOG =="
    before=$(git rev-parse --short HEAD)
    log "当前版本 $before，拉取 origin/$BRANCH ..."
    run git pull --rebase origin "$BRANCH"
    after=$(git rev-parse --short HEAD)
    if [ "$before" = "$after" ]; then
      log "已是最新 $after，跳过重启"
    else
      log "代码更新 $before → $after，新增提交："
      git --no-pager log --oneline "$before..$after" | sed 's/^/    /' | tee -a "$LOG"
      restart_service
    fi
    ;;
  restart)
    log "== restart 开始 | 服务=$SERVICE 版本=$(git rev-parse --short HEAD) =="
    restart_service
    ;;
  *)
    usage
    exit 1
    ;;
esac

log "== 结束（耗时 ${SECONDS}s）=="
