@AGENTS.md

# rethink — Claude Code overlay

`AGENTS.md`가 도구 공통의 자율 개발 계약이고, 이 파일은 그 위에 얹히는
Claude Code 전용 동작과 **이 저장소에만 해당하는 규칙**입니다.
충돌하면 아래의 프로젝트 규칙이 우선합니다.

## Claude Code 동작

- 프로젝트 명령이나 구조 지식이 필요하면 `.claude/state/PROJECT_PROFILE.md`를 읽습니다.
  비어 있거나 낡았으면 본격적인 구현 전에 `onboard-project` 스킬을 씁니다.
- 사소하지 않은 기능·버그 수정·리팩터에는 `autonomous-dev` 스킬을 적용합니다.
- 복잡한 작업에는 Task 도구를 쓰고, 실제 선행 관계는 flat todo 대신 의존성으로 표현합니다.
- 저장소 조사와 독립 리뷰는 main context 소음을 줄이는 경우에 subagent로 분리합니다.
- 병렬 작업자가 같은 파일을 건드릴 수 있으면 worktree로 격리합니다.
- 번들 스킬(`/code-review`, `/run`, `/security-review` 등)이 있으면 그것을 쓰고,
  같은 기능을 로컬에 다시 만들지 않습니다.
- Agent team은 experimental이므로 자동으로 켜지 않습니다. 기본은 단일 에이전트 + 필요한 subagent입니다.
- 중간 이상 규모의 변경은 완료 선언 전에 `independent-reviewer` subagent로 검토합니다.
- 컨텍스트나 세션을 넘길 수 있는 작업만 `.claude/state/WORK_STATUS.md`에 유지합니다.
- 되돌리기 어렵고 오래 남는 결정만 `.claude/state/DECISIONS.md`에 기록합니다. 일상적 구현 선택은 적지 않습니다.
- 코드를 고친 직후 멈추지 않습니다. 검증하고, 리뷰하고, 고친 뒤에 보고합니다.

---

# 프로젝트 고유 규칙

아래는 이 저장소에서 코딩 에이전트가 반드시 지켜야 하는 운영 규칙입니다. 문서(README)는
사람이 읽는 절차서이고, 이 파일은 에이전트가 자동으로 읽는 규칙입니다.
`AGENTS.md`의 일반 지침보다 우선합니다.

## 1. 컨테이너를 내리기 전에 DNAT를 먼저 해제한다

`docker restart rethink` / `docker stop rethink`를 단독으로 실행하지 마세요.
`scripts/deploy.sh`를 쓰거나, 수동이라면 먼저:

```sh
curl -fsS -X POST http://127.0.0.1:44401/api/router/dnat/release
```

가전 대부분은 keepalive가 60초라 금방 돌아오지만 세탁기류(`F21VDT_AKOR`, 미니워시)는
1200초입니다. 규칙을 걷어두면 그동안 가전이 LG 클라우드와 직접 통신하므로 상대를 잃지
않고, rethink가 올라오면 DNAT 조정기가 규칙을 되돌립니다.

이 규칙은 **컨테이너가 내려가는 모든 경우**에 적용됩니다. 설정 한 줄 수정, 로그 토픽
변경, 짧은 실험도 포함입니다. 버전 배포에만 해당하는 규칙이 아닙니다.

20분 안에 두 번 재시작하면 세탁기가 `clip/provisioning/devices/<id>`로
`{"cmd":"undeploy"}`를 보내 등록을 스스로 해제할 수 있고, 그러면 씽큐 앱에서 재등록이
필요합니다.

## 2. 정상 여부는 홈어시스턴트에서 확인한다

rethink의 로그, 관리 API의 `connected: true`, 브로커의 보존 메시지는 정상의 근거가
아닙니다. 관리 API의 연결 표시는 TCP 세션이 있다는 뜻일 뿐이고, 보존된 MQTT 값은 예전
실행에서 남은 것일 수 있습니다.

무엇이든 고쳤다고 보고하기 전에 `scripts/check-home-assistant.mts`를 실행해 11대 전부가
초기값을 받았고 엔티티가 `unavailable`이 아닌지 확인하세요.

**홈어시스턴트를 확인할 때는 두 곳을 모두 봅니다.**

- `ha-mcp` MCP 서버 — 엔티티 상태·이력·로그 등 살아 있는 값
- SSH로 접근하는 설정 폴더 — 설정은 `/config`. 이 저장소는 공개이므로 접속 주소와
  포트는 커밋하지 않습니다. 실제 값은 `CLAUDE.local.md`에 있습니다(gitignore 대상).

어느 한쪽만으로는 부족합니다. ha-mcp는 값이 최신인지 말해 주지만, `configuration.yaml`의
템플릿이 죽은 엔티티를 읽고 있는지, `.storage/lovelace.lovelace`가 어떤 엔티티를 참조하는지,
`core.config_entries`에 레지스트리 개명이 닿지 않는 entity_id가 들어 있는지는 설정 폴더에서만
드러납니다. 반대로 파일만 봐서는 값이 신선한지 알 수 없습니다.

`.storage` 파일은 **읽기만** 하세요. 홈어시스턴트의 내부 상태라 직접 쓰면 무시되거나
덮어써집니다. 변경은 ha-mcp나 홈어시스턴트 API로 합니다.

## 3. 시각은 한국 표준시로 적는다

컨테이너 로그는 UTC(`...Z`), LG 클라우드는 epoch ms, 패킷 캡처도 UTC입니다. 사용자에게
보고하는 모든 시각은 Asia/Seoul(UTC+9)로 변환해서 적으세요.
