# rethink 작업 규칙

이 저장소에서 코딩 에이전트가 반드시 지켜야 하는 운영 규칙입니다. 문서(README)는
사람이 읽는 절차서이고, 이 파일은 에이전트가 자동으로 읽는 규칙입니다.

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
- SSH로 접근하는 설정 폴더 — `ssh -p PORT root@HA-HOST`, 설정은 `/config`

어느 한쪽만으로는 부족합니다. ha-mcp는 값이 최신인지 말해 주지만, `configuration.yaml`의
템플릿이 죽은 엔티티를 읽고 있는지, `.storage/lovelace.lovelace`가 어떤 엔티티를 참조하는지,
`core.config_entries`에 레지스트리 개명이 닿지 않는 entity_id가 들어 있는지는 설정 폴더에서만
드러납니다. 반대로 파일만 봐서는 값이 신선한지 알 수 없습니다.

`.storage` 파일은 **읽기만** 하세요. 홈어시스턴트의 내부 상태라 직접 쓰면 무시되거나
덮어써집니다. 변경은 ha-mcp나 홈어시스턴트 API로 합니다.

## 3. 시각은 한국 표준시로 적는다

컨테이너 로그는 UTC(`...Z`), LG 클라우드는 epoch ms, 패킷 캡처도 UTC입니다. 사용자에게
보고하는 모든 시각은 Asia/Seoul(UTC+9)로 변환해서 적으세요.
