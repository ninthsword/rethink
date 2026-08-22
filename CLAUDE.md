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
초기값을 받았고 엔티티가 `unavailable`이 아닌지 확인하세요. 홈어시스턴트에 직접 닿는
`ha-mcp` MCP 서버도 이 프로젝트에 설정되어 있습니다.

## 3. 시각은 한국 표준시로 적는다

컨테이너 로그는 UTC(`...Z`), LG 클라우드는 epoch ms, 패킷 캡처도 UTC입니다. 사용자에게
보고하는 모든 시각은 Asia/Seoul(UTC+9)로 변환해서 적으세요.
