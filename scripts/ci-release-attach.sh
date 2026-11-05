#!/usr/bin/env bash
# 把参数里的文件附到当前 tag 的 Gitea Release(tag 对应的 Release 不存在则先建)。
# 同名 asset 先删后传——流水线重跑幂等,不会堆积重复附件。
# 依赖环境变量(Gitea Actions 运行时自带):GITHUB_API_URL / GITHUB_REPOSITORY / GITHUB_REF_NAME / RELEASE_TOKEN
# JSON 解析用 python3(dev host 必有),不用 sed 正则——Gitea 回包嵌套对象里满是 "id",正则取必错。
set -euo pipefail

for v in GITHUB_API_URL GITHUB_REPOSITORY GITHUB_REF_NAME RELEASE_TOKEN; do
  eval "val=\${$v:-}"
  [ -n "$val" ] || { echo "缺少环境变量 $v" >&2; exit 1; }
done
[ "$#" -ge 1 ] || { echo "用法: $0 <文件>..." >&2; exit 1; }

TAG="$GITHUB_REF_NAME"
API="$GITHUB_API_URL/repos/$GITHUB_REPOSITORY/releases"
AUTH="Authorization: token $RELEASE_TOKEN"

jget() { # stdin JSON -> 取嵌套键值(小写键名),失败输出空
  python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(1)
for k in sys.argv[1:]:
    if isinstance(d,list):
        d=d[int(k)] if -int(k)<=int(k)<len(d) else None
    else:
        d=d.get(k)
    if d is None: break
print(d if d is not None else "")' "$@"
}

asset_id_by_name() { # $1=release_id $2=name -> 输出 asset id 或空
  curl -sSf -H "$AUTH" "$API/$1/assets" | python3 -c '
import json,sys
want=sys.argv[1]
for a in json.load(sys.stdin):
    if a.get("name")==want: print(a["id"]); break' "$2" 2>/dev/null || true
}

# 1) 按 tag 找现有 Release,没有则建(body 用 tag 注释,轻量 tag 退回默认文案)
rel_id=$(curl -sSf -H "$AUTH" "$API/tags/$TAG" 2>/dev/null | jget id || true)
if [ -z "$rel_id" ] || [ "$rel_id" = "None" ]; then
  body=$(git tag -l --format='%(contents)' "$TAG" 2>/dev/null | head -c 6000 | tr -d '\r')
  [ -n "$body" ] || body="自动发布(CI 直出)"
  payload=$(TAGV="$TAG" BODY="$body" python3 -c '
import json,os
print(json.dumps({"tag_name":os.environ["TAGV"],"name":os.environ["TAGV"],"body":os.environ["BODY"]}))')
  rel_id=$(curl -sSf -H "$AUTH" -H "Content-Type: application/json" -X POST "$API" -d "$payload" | jget id || true)
fi
[ -n "$rel_id" ] && [ "$rel_id" != "None" ] || { echo "建/查 Release 失败: $TAG" >&2; exit 1; }
echo "Release $TAG -> id=$rel_id"

# 2) 逐个附件:同名旧 asset 先删(幂等),再上传
for f in "$@"; do
  name=$(basename "$f")
  old_id=$(asset_id_by_name "$rel_id" "$name")
  if [ -n "$old_id" ]; then
    curl -sSf -X DELETE -H "$AUTH" "$API/$rel_id/assets/$old_id" >/dev/null \
      && echo "删除旧 asset $name (id=$old_id)"
  fi
  curl -sSf -H "$AUTH" -X POST "$API/$rel_id/assets?name=$name" -F "attachment=@$f" >/dev/null \
    && echo "上传 $name ($(du -h "$f" | cut -f1)) 完成"
done
