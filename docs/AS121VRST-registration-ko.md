# AS121VRST Rethink 등록 절차

이 문서는 구형 ThinQ 1 공기청정기 AS121VRST(모델 ID `AIR_910604_WW`)를 Home Assistant의
Rethink 애드온에 연결한 실제 절차를 정리한다. 계정, 토큰, 기기 UUID와 내부 인증값은 기록하지 않는다.

## 확인된 환경 특성

- 기기 설정용 Wi-Fi AP의 게이트웨이는 `192.168.1.1`이다.
- 휴대폰이 설정용 AP에 연결되면 `192.168.1.2` 같은 주소를 받을 수 있다. 이 주소는 공기청정기의
  홈 네트워크 주소가 아니라 휴대폰에 임시로 할당된 주소다.
- 홈 공유기도 `192.168.1.0/24`를 사용하면 설정용 AP와 경로가 겹칠 수 있다.
- 이 환경에서는 Rethink 초기 설정 도구가 기기의 설정 포트에 도달하지 못했지만 LG ThinQ 앱 등록은 성공했다.
- LG 앱 등록 후 공기청정기는 홈 공유기에서 별도의 DHCP 주소를 받는다.

## 사전 준비

1. Rethink 애드온과 MQTT Broker를 설치하고 두 연결 상태가 정상인지 확인한다.
2. Home Assistant에 고정 IP를 할당한다.
3. 공기청정기가 연결될 2.4 GHz Wi-Fi의 SSID와 암호를 준비한다.
4. 공유기의 게스트 네트워크 및 AP 격리를 끄고 공기청정기에서 Home Assistant로 접근할 수 있게 한다.
5. AdGuard Home을 사용할 경우 공기청정기가 실제로 AdGuard Home을 DNS 서버로 사용하도록 DHCP 설정을 확인한다.

## 1. 공기청정기를 홈 Wi-Fi에 등록

1. 공기청정기의 Wi-Fi 설정을 초기화하고 설정 모드로 진입한다.
2. LG ThinQ 앱에서 AS121VRST를 추가하고 홈 Wi-Fi 정보를 전달한다.
3. 앱 등록이 끝나면 공유기의 DHCP 클라이언트 목록에서 새 LG 기기의 주소를 찾는다.
4. MAC 주소를 기준으로 공기청정기에 DHCP 고정 할당을 설정한다.

설정용 AP에 연결된 휴대폰에서 보이는 `192.168.1.2`를 공기청정기 주소로 사용하면 안 된다. 홈 Wi-Fi
등록 후 공유기에서 받은 주소가 실제 운영 주소다.

## 2. ThinQ 1 도메인을 Rethink로 연결

AS121VRST는 운영 중 `kic.lgthinq.com`에 접속한다. 공기청정기의 DNS 응답만 다음처럼 재작성한다.

```text
kic.lgthinq.com -> <Home Assistant 고정 IP>
```

가능하면 공기청정기 클라이언트에만 적용한다. Home Assistant/Rethink 호스트까지 같은 재작성을 적용하면
브릿지가 실제 LG ThinQ 서버에 접속하지 못하고 자기 자신으로 되돌아올 수 있다. AdGuard Home에서
클라이언트별 정책을 사용할 수 없다면 공기청정기 전용 DNS 또는 별도 네트워크를 사용하거나,
Home Assistant 호스트가 재작성되지 않은 DNS를 사용하도록 구성한다.

다음 도메인은 Rethink로 재작성하지 않는다.

```text
common.lgthinq.com
kic-service.lgthinq.com
kic-report.lgthinq.com
```

`kic-report.lgthinq.com`은 보고용 엔드포인트로 관찰됐으며 로컬 제어 연결 대상이 아니다.

## 3. DNS 캐시를 갱신하고 연결 확인

1. AdGuard Home의 DNS 캐시를 비운다.
2. 공기청정기의 전원을 완전히 껐다가 다시 켠다. 기기가 이전 DNS 결과를 보관할 수 있기 때문이다.
3. Rethink 로그에서 다음 흐름을 확인한다.

```text
HTTPS kic.lgthinq.com /lgehadm/api/Device/TotalDeviceInfoSvc
incoming ... "Cmd":"DevInfo" ...
thinq1 device type AIR_910604_WW
```

관찰된 최초 `DevInfo`에는 시간대, 그룹 유형 및 펌웨어 정보가 포함된다.

```text
TimeZone=+0900,GroupType=12,FwVer=2.6.7_RTOS_3K,regFail=N
```

Home Assistant의 MQTT Discovery가 완료되면 LG 공기청정기 기기와 확인된 제어·필터 엔티티가 생성된다.

## 4. 선택 사항: LG 브릿지 모드

브릿지 모드는 공기청정기 연결을 Rethink가 받은 뒤 실제 LG ThinQ 클라우드에도 전달하는 역공학 기능이다.

1. Rethink 관리 화면에서 ThinQ 계정에 로그인한다.
2. 공기청정기 행의 브릿지를 활성화한다.
3. 기기 유형을 요구하면 설정 과정에서 확인한 실제 3자리 `deviceType`을 입력한다. 추측값을 사용하지 않는다.
4. LG 앱에서 기기가 등록됐는지 확인한다.

브릿지를 사용해도 공기청정기의 `kic.lgthinq.com` DNS 재작성은 유지해야 한다. 대신 Rethink 호스트는
실제 LG 서비스 도메인을 정상적으로 해석하고 인터넷에 접속할 수 있어야 한다.

## 현재 제공되는 Home Assistant 기능

- Fan 엔티티 전원 켜기/끄기
- 쾌속 모드 켜기/끄기
- 공기 제균 켜기/끄기
- 취침 예약: 끔, 2시간, 4시간, 8시간, 12시간
- Fan 프리셋 풍속: 약, 중, 강, 자동
- PM1.0, PM2.5, PM10 (`µg/m³`)
- 필터 잔여 시간
- 필터 잔여율

팬 RPM, 스마트 진단, 오염도 단계의 의미 및 켜기/끄기 예약 상태는 확인되지 않아 아직 제공하지 않는다.

## 문제 해결

### 설정 도구가 다른 주소의 5500 포트에 접속하려고 함

설정용 AP와 홈 공유기가 모두 `192.168.1.0/24`를 사용하면 Windows의 이더넷 경로와 기기 AP 경로가
충돌할 수 있다. 이 모델에서는 LG ThinQ 앱으로 Wi-Fi 등록을 먼저 완료한 뒤 DNS를 Rethink로 전환하는
방식이 확인됐다.

### 웹에서는 열리지만 기기가 Rethink에 접속하지 않음

- 공기청정기가 사용하는 DNS 서버가 AdGuard Home인지 확인한다.
- 재작성 결과가 Home Assistant 고정 IP인지 확인한다.
- 공기청정기를 완전히 껐다 켜 DNS 캐시를 갱신한다.
- Home Assistant의 `46030` 포트에 같은 LAN에서 접근 가능한지 확인한다.

### 로그가 Alive만 반복함

`Alive`는 연결 유지 패킷이다. 최초 연결 시 `DevInfo`가 한 번 수신됐다면 기본 연결은 완료된 상태다.
Rethink는 전원이 켜져 있으면 60초, 꺼져 있으면 5분마다 `Mon/Start`로 상태를 한 번 받은 뒤
`Mon/Stop`으로 구독을 중단한다. Home Assistant나 본체 조작으로 Data 없는 성공 응답이 오면 정기 주기를
기다리지 않고 바로 단발 조회하며, 필터 정보는 최초 상태 확인 뒤 `MFilter` 조회로 별도 수신한다.

### 로그 공유 시 주의

ThinQ 브릿지 로그의 인증 헤더에는 계정 토큰과 사용자 식별자가 포함될 수 있다. 로그를 공유하기 전에
`x-emp-token`, `x-client-id`, `x-user-no`, 이메일, 기기 UUID를 제거한다.
