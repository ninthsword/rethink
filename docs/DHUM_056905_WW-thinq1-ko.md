# ThinQ1 DHUM_056905_WW 작은방제습기

작은방제습기는 같은 modelId의 거실제습기와 달리 `platformType=thinq1`, 펌웨어
`2.6.7_RTOS_3K`인 구형 JSON 프로토콜 기기다. ThinQ2 TLV 핸들러를 재사용하지 않고
`kic.lgthinq.com:46030` 연결을 처리하는 전용 핸들러를 사용한다.

## 연결 준비

`AS121VRST-registration-ko.md`와 동일하게 기기를 ThinQ 앱과 홈 2.4 GHz Wi-Fi에 먼저
등록하고 DHCP 고정 주소를 설정한다. OpenWrt처럼 클라이언트별 DNS 응답을 만들 수 있으면
이 기기에서 조회하는 `kic.lgthinq.com`만 rethink 호스트 주소로 재작성한다.
`common.lgthinq.com`, `kic-service.lgthinq.com`, `kic-report.lgthinq.com`은 재작성하지
않는다. rethink 호스트 자체도 DNS 재작성 대상에서 제외해야 한다.

클라이언트별 DNS 재작성이 어려운 라우터에서는 기기 출발지 IP에만 다음 TCP DNAT를 적용할
수 있다. 현재 작은방제습기 연결 시험에는 이 방식을 사용했다.

```text
small-room-dhum tcp/46030 -> rethink:46030
small-room-dhum tcp/47878 -> rethink:47878
```

ThinQ2용 `443 -> 4433`, `8883 -> 8883` 규칙과 혼용하지 않는다. 관리 API는 연결된 기기의
플랫폼을 `thinq1`으로 저장하고 위 포트 쌍을 사용해 DNAT 상태를 관리한다.

DNS 캐시를 비운 다음 기기의 전원을 완전히 껐다 켜고, 로그에서 다음 흐름을 확인한다.

```text
HTTPS kic.lgthinq.com /lgehadm/api/Device/TotalDeviceInfoSvc
thinq1 device type DHUM_056905_WW
```

## 구현된 기능

- 전원 켜기/끄기
- 목표 습도 30~70%, 5% 단위
- 현재 습도
- 운전 모드: 스마트제습, 쾌속제습, 저소음제습, 집중건조, 의류건조
- 풍량: 약, 중, 강, 파워
- 물통 조명
- 청정 건조
- 습도 센서 모드: 운전 중에만, 항상
- 오류 코드

모든 상태는 `Mon/Start`의 JSON 응답으로 재확인하며, 제어 성공 응답 뒤 즉시 단발 조회한다.
전원 켜짐 중에는 60초, 꺼짐 중에는 5분 간격으로 상태를 갱신한다.

`TotalDeviceInfoSvc`에서 받은 모델 메타데이터는 `state/thinq1-metadata.json`에 저장한다.
따라서 rethink만 재시작해도 기기의 HTTPS 등록 요청이나 전원 재인가를 기다리지 않고 RTI
연결을 다시 받을 수 있다.

현재 ThinQ1 연결에는 ThinQ2 클라우드 브리지를 적용하지 않는다. DNAT가 켜진 동안에는
공식 ThinQ 앱에서 이 기기가 오프라인으로 표시될 수 있다. 공식 앱과 로컬 제어를 동시에 쓰려면
ThinQ1 프로토콜용 별도 클라우드 브리지 구현과 검증이 필요하다.

## 보류

물통 만수는 모델 JSON에서 모니터링 필드가 아니라 푸시 그룹 `40301/0001`로만 확인된다.
`ProductStatus`를 만수로 간주할 실측 근거가 없으므로 센서를 만들지 않았다. 실제 만수/정상
전환 시 로컬 수신 패킷 또는 푸시를 각각 캡처한 뒤 추가한다.
