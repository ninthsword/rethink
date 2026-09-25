/* Shared presentation only. Device names, models and payloads never enter the dictionary. */
const UI = (() => {
    const korean = {
        'Rethink management': 'Rethink 관리',
        'Router management': '공유기 관리',
        'Device monitor': '기기 모니터',
        'Management navigation': '관리 메뉴',
        Devices: '기기',
        Router: '공유기',
        Language: '언어',
        'Build:': '빌드:',
        'Process started:': '프로세스 시작:',
        Connectivity: '연결 상태',
        'Browser ↔ Rethink': '브라우저 ↔ Rethink',
        'Rethink ↔ MQTT': 'Rethink ↔ MQTT',
        'Connected devices': '연결된 기기',
        Device: '기기',
        Model: '모델',
        Mode: '모드',
        'Local connection': '로컬 연결',
        'LG forwarding': 'LG 전달',
        Monitor: '모니터',
        Tools: '도구',
        'Waiting for appliances to connect to Rethink.': '기기가 Rethink에 연결되기를 기다리는 중입니다.',
        'DNAT couples managed router forwarding with saved LG registration. Local uses the appliance’s existing connection setup and offers an optional LG Bridge. Changing mode does not change routes or certificates. Connection status is separate from Home Assistant entity health.':
            'DNAT는 관리형 공유기 전달과 저장된 LG 등록을 함께 사용합니다. Local은 기기의 기존 연결을 사용하며 LG Bridge를 선택할 수 있습니다. 모드 변경은 경로나 인증서를 변경하지 않습니다. 연결 상태와 Home Assistant 엔티티 상태는 별개입니다.',
        'For the supported DNAT ↔ Local switching workflow, the appliance certificates differ. In either direction, remove appliance power to reset its Wi-Fi module, restore power, then repeat Wi-Fi setup and appliance certificate enrollment for the target mode using the appliance-specific instructions. Review and explicitly approve the mode-change dialog. Saving policy does not perform or verify these physical steps. Bridge Restore / Set up / Renew concerns upstream LG registration and does not enroll the physical appliance’s Wi-Fi certificate.':
            '지원되는 DNAT ↔ Local 전환에서는 기기 인증서가 서로 다릅니다. 어느 방향이든 기기 전원을 제거하여 Wi-Fi 모듈을 초기화하고 전원을 다시 연결한 뒤, 기기별 안내에 따라 대상 모드의 Wi-Fi 설정과 기기 인증서 등록을 반복해야 합니다. 모드 변경 대화상자를 읽고 명시적으로 승인하세요. 정책 저장은 이 물리적 절차를 수행하거나 검증하지 않습니다. Bridge 복원 / 설정 / 갱신은 상위 LG 등록을 관리하며 실제 기기의 Wi-Fi 인증서를 등록하지 않습니다.',
        'Follow the': '새 기기 연결은',
        'wiki instructions': '위키 안내',
        'to connect new devices.': '를 따라 진행하세요.',
        'LG account': 'LG 계정',
        'Status:': '상태:',
        'Log into your LG account': 'LG 계정 로그인',
        logout: '로그아웃',
        'Log into your LG ThinQ account': 'LG ThinQ 계정 로그인',
        'Make sure to enter a country code that matches your account. The LG login page will open in a window. Please proceed with the login, then copy the URL from the final blank page.':
            '계정과 일치하는 국가 코드를 입력하세요. 새 창에서 LG 로그인 페이지가 열립니다. 로그인 후 마지막 빈 페이지의 URL을 복사하세요.',
        'Country code': '국가 코드',
        'Log in': '로그인',
        'Paste the final URL below.': '마지막 URL을 아래에 붙여 넣으세요.',
        Continue: '계속',
        Close: '닫기',
        'Logout confirmation': '로그아웃 확인',
        'Signing out removes the account login used for setup and renewal. Saved appliance registrations and forwarding intent remain.':
            '로그아웃하면 설정과 갱신에 사용하는 계정 로그인만 제거됩니다. 저장된 기기 등록과 전달 설정은 유지됩니다.',
        'Log out': '로그아웃',
        Cancel: '취소',
        'Select device type': '기기 유형 선택',
        'Device type': '기기 유형',
        'Please select the appropriate type for this device. This value usually consists of three digits and can be obtained during the setup process. The device will only register with the ThinQ cloud if the device type is set correctly.':
            '이 기기에 맞는 유형을 선택하세요. 보통 세 자리 숫자이며 설정 과정에서 확인할 수 있습니다. 올바른 기기 유형을 지정해야 ThinQ 클라우드에 등록됩니다.',
        'Router SSH settings': '공유기 SSH 설정',
        'Router IP': '공유기 IP',
        'SSH Port': 'SSH 포트',
        Username: '사용자 이름',
        Password: '비밀번호',
        'Show password': '비밀번호 표시',
        'Hide password': '비밀번호 숨기기',
        'Rethink IP': 'Rethink IP',
        'Leave the password blank to keep the saved password.':
            '저장된 비밀번호를 유지하려면 비밀번호 입력란을 비워 두세요.',
        'Test saved settings': '저장된 설정 테스트',
        'Save changes first. This test uses only the saved router settings.':
            '변경 사항을 먼저 저장하세요. 이 테스트는 저장된 공유기 설정만 사용합니다.',
        Save: '저장',
        'Appliance modes': '기기 모드',
        'Router:': '공유기:',
        'Not configured': '설정되지 않음',
        Refresh: '새로고침',
        'DNAT automatically forwards to LG using saved registration when enabled. Local offers an optional LG Bridge without router SSH. Turn DNAT off before changing modes. Local requires an existing independent path from the appliance to Rethink; saving this policy does not create that path or reprovision certificates.':
            'DNAT를 켜면 저장된 등록으로 LG에 자동 전달합니다. Local은 공유기 SSH 없이 LG Bridge를 선택할 수 있습니다. 모드를 변경하기 전에 DNAT를 끄세요. Local에는 기기에서 Rethink로 연결되는 독립 경로가 이미 있어야 합니다. 정책 저장은 경로를 만들거나 인증서를 재설정하지 않습니다.',
        Name: '이름',
        Action: '작업',
        Actions: '작업',
        'No devices registered. Add an IP address first.': '등록된 기기가 없습니다. 먼저 IP 주소를 추가하세요.',
        'Add device': '기기 추가',
        'Device IP': '기기 IP',
        'Forwarding mode': '전달 모드',
        'Local (existing Rethink connection)': 'Local (기존 Rethink 연결)',
        'Add an appliance IP to manage forwarding. Existing entries default to DNAT. The appliance is linked when it connects to Rethink. Mode selection changes policy only; it does not change the deployment-wide appliance route, Wi-Fi setup or certificates. No cloud pairing occurs until you explicitly choose Set up or Renew.':
            '전달을 관리할 기기의 IP를 추가하세요. 기존 항목의 기본값은 DNAT입니다. 기기가 Rethink에 연결되면 연결됩니다. 모드 선택은 정책만 바꾸며 배포 전체의 기기 경로, Wi-Fi 설정 또는 인증서를 변경하지 않습니다. 설정 또는 갱신을 명시적으로 선택하기 전에는 클라우드 페어링을 하지 않습니다.',
        Add: '추가',
        'Device status': '기기 상태',
        'Device ID': '기기 ID',
        Status: '상태',
        Messages: '메시지',
        'Auto-scroll': '자동 스크롤',
        'Send to device': '기기로 전송',
        'Inject from device': '기기에서 보낸 것으로 주입',
        Connected: '연결됨',
        Unknown: '알 수 없음',
        'Disconnected · displayed device status is stale': '연결 끊김 · 표시된 기기 상태는 이전 정보입니다',
        'Disconnected · displayed status is stale': '연결 끊김 · 표시된 상태는 이전 정보입니다',
        'MQTT connected (entity health is separate)': 'MQTT 연결됨 (엔티티 상태는 별도)',
        'MQTT disconnected': 'MQTT 연결 끊김',
        'Signed in · separate from appliance forwarding': '로그인됨 · 기기 전달 상태와 별도',
        'Sign in for explicit setup / renewal': '설정 / 갱신을 위해 로그인하세요',
        'LG account integration is not configured': 'LG 계정 연동이 설정되지 않았습니다',
        'Invalid status response. Reconnect to refresh.': '잘못된 상태 응답입니다. 다시 연결하여 갱신하세요.',
        ' · HA mapping unavailable': ' · HA 매핑 없음',
        'Connected to Rethink': 'Rethink에 연결됨',
        'Stale · connection unknown': '이전 정보 · 연결 상태 알 수 없음',
        'Stale · LG status unknown': '이전 정보 · LG 상태 알 수 없음',
        'LG connected': 'LG 연결됨',
        'LG connecting / retrying': 'LG 연결 중 / 재시도 중',
        'Forwarding requested': '전달 요청됨',
        'LG forwarding off': 'LG 전달 꺼짐',
        'Registration saved': '등록 저장됨',
        'Archived registration available': '보관된 등록 있음',
        'Setup required': '설정 필요',
        'Manage DNAT and automatic forwarding': 'DNAT 및 자동 전달 관리',
        'Optional LG Bridge for {0}': '{0}의 선택적 LG Bridge',
        ' Optional LG Bridge': ' 선택적 LG Bridge',
        'Registration…': '등록…',
        'Set up registration…': '등록 설정…',
        'Working…': '처리 중…',
        'Registration · {0}': '등록 · {0}',
        Restore: '복원',
        Renew: '갱신',
        'Set up': '설정',
        'Device type (for example 401)': '기기 유형 (예: 401)',
        'Device type if unknown (for example 401)': '유형을 모르는 경우 입력 (예: 401)',
        'LG device type': 'LG 기기 유형',
        'These actions manage upstream LG registration, not the physical appliance’s Wi-Fi certificate enrollment. Restore reuses an archived registration only when no current one exists. Renew / Set up explicitly contacts LG and may pair a new certificate. Previous local material is kept if this fails; remote pairing cannot be rolled back. DNAT preserves Home membership, which does not guarantee appliance credential continuity.':
            '이 작업은 상위 LG 등록을 관리하며 실제 기기의 Wi-Fi 인증서 등록과는 다릅니다. 현재 등록이 없을 때만 보관된 등록을 복원할 수 있습니다. 갱신 / 설정은 LG에 접속하여 새 인증서를 페어링할 수 있습니다. 실패 시 이전 로컬 자료를 유지하지만 원격 페어링은 되돌릴 수 없습니다. DNAT의 Home 구성원 유지는 기기 자격 증명의 연속성을 보장하지 않습니다.',
        'These actions manage upstream LG registration, not the physical appliance’s Wi-Fi certificate enrollment. Restore reuses the archive only when no current registration exists. Renew / Set up contacts LG and may pair a new certificate. Previous local material stays until replacement succeeds; remote pairing cannot be rolled back. Preserving LG Home membership does not prove that the appliance keeps its credentials.':
            '이 작업은 상위 LG 등록을 관리하며 실제 기기의 Wi-Fi 인증서 등록과는 다릅니다. 현재 등록이 없을 때만 보관 자료를 복원합니다. 갱신 / 설정은 LG에 접속하여 새 인증서를 페어링할 수 있습니다. 교체에 성공할 때까지 이전 로컬 자료를 유지하지만 원격 페어링은 되돌릴 수 없습니다. LG Home 구성원 유지가 기기의 자격 증명 유지를 증명하지는 않습니다.',
        'Saved; leave blank to keep': '저장됨 · 유지하려면 비워 두세요',
        'Router settings saved': '공유기 설정을 저장했습니다',
        'Router connection test succeeded': '공유기 연결 테스트에 성공했습니다',
        'Connected: {0}; {1}': '연결됨: {0}; {1}',
        'SSH unavailable · Local controls remain available': 'SSH 연결 불가 · Local 제어는 사용 가능',
        'SSH not configured · Local controls remain available': 'SSH 미설정 · Local 제어는 사용 가능',
        'No appliance linked': '연결된 기기 없음',
        'Waiting for appliance connection': '기기 연결 대기 중',
        'Appliance for {0}': '{0}에 연결할 기기',
        Link: '연결',
        'Mode for {0}': '{0}의 모드',
        'Not used in Local mode': 'Local 모드에서 사용하지 않음',
        'Released · paused until Enable or restart': '해제됨 · 활성화 또는 재시작까지 일시 중지',
        'Rules: {0}': '규칙: {0}',
        on: '켜짐',
        off: '꺼짐',
        partial: '일부 적용',
        unknown: '알 수 없음',
        stale: '이전 정보',
        'Turn off': '끄기',
        'Repair / Enable': '복구 / 켜기',
        Enable: '켜기',
        'Automatic with DNAT · no separate Bridge switch': 'DNAT와 함께 자동 작동 · 별도 Bridge 스위치 없음',
        Rename: '이름 변경',
        Remove: '제거',
        'Custom name (blank = detected name)': '사용자 지정 이름 (비우면 감지된 이름 사용)',
        'Remove {0}? Turn DNAT off first. Registration will be archived; the LG appliance is not deleted.':
            '{0}을(를) 제거할까요? 먼저 DNAT를 끄세요. 등록은 보관되며 LG 기기는 삭제되지 않습니다.',
        'Approve mode change · {0} → {1}': '모드 변경 승인 · {0} → {1}',
        'Approve mode change': '모드 변경 승인',
        'For this supported switching workflow, DNAT and Local use different appliance certificates. Switching in either direction requires removing appliance power to reset its Wi-Fi module, then restoring power and repeating Wi-Fi setup and appliance certificate enrollment for the target mode. Follow the appliance-specific instructions; no universal reset duration is assumed.':
            '지원되는 전환 절차에서 DNAT와 Local은 서로 다른 기기 인증서를 사용합니다. 어느 방향이든 기기 전원을 제거하여 Wi-Fi 모듈을 초기화한 뒤 전원을 복원하고 대상 모드의 Wi-Fi 설정과 기기 인증서 등록을 반복해야 합니다. 기기별 안내를 따르세요. 모든 기기에 공통인 초기화 시간은 가정하지 않습니다.',
        'Target: Local. Keep managed DNAT off and establish an independent appliance connection to Rethink. Use the Local-mode Wi-Fi setup and Rethink appliance-certificate enrollment procedure after the power-removal reset.':
            '대상: Local. 관리형 DNAT를 끄고 기기에서 Rethink로 독립적으로 연결하세요. 전원 제거 초기화 후 Local 모드의 Wi-Fi 설정과 Rethink 기기 인증서 등록 절차를 따르세요.',
        'Target: DNAT. Use the DNAT network setup and target-mode Wi-Fi / appliance-certificate enrollment procedure after the power-removal reset. Release existing managed DNAT rules before changing policy; configure DNAT for the target enrollment procedure.':
            '대상: DNAT. 전원 제거 초기화 후 DNAT 네트워크 설정과 대상 모드의 Wi-Fi / 기기 인증서 등록 절차를 따르세요. 정책 변경 전에 기존 관리형 DNAT 규칙을 해제하고 대상 등록 절차에 맞게 DNAT를 설정하세요.',
        'Approval saves forwarding policy only. This page neither performs nor verifies physical reset, Wi-Fi enrollment or certificate conversion. Bridge Restore / Set up / Renew manages upstream LG registration; it does not enroll the physical appliance’s Wi-Fi certificate.':
            '승인은 전달 정책만 저장합니다. 이 페이지는 물리적 초기화, Wi-Fi 등록 또는 인증서 변환을 수행하거나 검증하지 않습니다. Bridge 복원 / 설정 / 갱신은 상위 LG 등록을 관리하며 실제 기기의 Wi-Fi 인증서를 등록하지 않습니다.',
        'Acknowledge reset and target-mode appliance enrollment requirements':
            '초기화 및 대상 모드의 기기 등록 요구 사항 확인',
        ' I understand the reset and target-mode appliance enrollment requirements and approve this policy change.':
            ' 초기화 및 대상 모드의 기기 등록 요구 사항을 이해했으며 이 정책 변경을 승인합니다.',
        'Device state changed or management is unavailable. Cancel and refresh before approving a new transition.':
            '기기 상태가 변경되었거나 관리 연결을 사용할 수 없습니다. 취소하고 새로고침한 후 다시 승인하세요.',
        '{0} policy saved. Physical Wi-Fi-module reset and target-mode appliance certificate enrollment are not performed or verified by this page.':
            '{0} 정책을 저장했습니다. 이 페이지는 물리적 Wi-Fi 모듈 초기화와 대상 모드의 기기 인증서 등록을 수행하거나 검증하지 않습니다.',
        'Waiting for Rethink connection…': 'Rethink 연결 대기 중…',
        'Appliance offline': '기기 오프라인',
        'Appliance online': '기기 온라인',
        'Invalid message received. Waiting for the next update.': '잘못된 메시지를 받았습니다. 다음 갱신을 기다립니다.',
        'Invalid JSON. Correct the input and try again.':
            'JSON 형식이 올바르지 않습니다. 입력을 수정한 후 다시 시도하세요.',
        'Connection unavailable. Command was not sent.': '연결할 수 없어 명령을 보내지 않았습니다.',
        'Copy payload to input': '입력란에 원문 복사',
        '{0} older messages discarded': '이전 메시지 {0}개 삭제됨',
        'Management sign in': '관리 로그인',
        'Sign in': '로그인',
        'Admin password': '관리자 비밀번호',
        'Your session lasts 10 minutes. Only explicit extension renews it.':
            '세션은 10분 동안 유지됩니다. 명시적으로 연장해야 갱신됩니다.',
        'Unable to sign in.': '로그인할 수 없습니다.',
        'Login unavailable. Try again later.': '지금 로그인할 수 없습니다. 잠시 후 다시 시도하세요.',
        'Session expires soon': '세션이 곧 만료됩니다',
        'Extend session': '세션 연장',
        '{0} seconds remaining': '{0}초 남음',
        'Checking session…': '세션 확인 중…',
        'Session check failed. Controls are locked.': '세션을 확인할 수 없어 제어를 잠갔습니다.',
        Session: '세션',
        Dismiss: '나중에',
        'Session expired': '세션 만료',
    }
    let locale = navigator.languages?.some((language) => language.toLowerCase().startsWith('ko')) ? 'ko' : 'en'
    try {
        const saved = localStorage.getItem('rethink.language')
        if (saved === 'ko' || saved === 'en') locale = saved
    } catch {}
    const bindings = new Map()
    const listeners = new Set()
    function t(key, parameters = []) {
        key = Object.keys(korean).find((original) => korean[original] === key) || key
        const text = locale === 'ko' ? (korean[key] ?? key) : key
        return text.replace(/\{(\d+)\}/g, (_match, index) => String(parameters[Number(index)] ?? ''))
    }
    const diagnosticMessages = {
        'Turn all DNAT entries off before changing router settings.':
            '공유기 설정을 변경하려면 모든 기기의 DNAT를 먼저 끄세요.',
        'Release all existing DNAT rules before changing router settings.':
            '공유기 설정을 변경하려면 기존 DNAT 규칙을 모두 해제하세요.',
        'Turn DNAT off before changing this entry.': '이 기기의 DNAT를 끈 뒤 다시 시도하세요.',
        'Choose DNAT mode before enabling router forwarding.': '공유기 전달을 켜려면 먼저 DNAT 모드를 선택하세요.',
        'DNAT forwarding follows DNAT. Use the DNAT control, or turn DNAT off and choose Local mode.':
            'DNAT 전달은 DNAT 제어에서 관리하세요. Local 모드로 변경하려면 DNAT를 먼저 끄세요.',
        'DNAT forwarding follows DNAT. Use the router DNAT control.':
            'DNAT 전달은 공유기 페이지의 DNAT 제어에서 관리하세요.',
        'DNAT forwarding follows DNAT. Use the DNAT control.': 'DNAT 전달은 DNAT 제어에서 관리하세요.',
        'Registration required. Choose Restore or Set up registration.':
            'LG 등록이 필요합니다. 등록 복원 또는 설정을 선택하세요.',
        'Registration required': 'LG 등록이 필요합니다. 등록 복원 또는 설정을 선택하세요.',
        'Restore or set up first': '먼저 LG 등록을 복원하거나 설정하세요.',
        'No archived registration is available to restore.': '복원할 보관 등록이 없습니다. 새 등록을 설정하세요.',
        'Current registration takes precedence; renewal is explicit.':
            '현재 등록이 있습니다. 교체하려면 등록 갱신을 명시적으로 선택하세요.',
        'Registration is preserved. Use Suspend in Local mode or explicit registration renewal.':
            '기존 등록은 유지됩니다. Local 모드에서는 일시 중지를 사용하거나 등록 갱신을 선택하세요.',
        'Appliance is not connected to Rethink. Wait for its next connection.':
            '기기가 Rethink에 연결되지 않았습니다. 다시 연결될 때까지 기다리세요.',
        'Appliance or forwarding changed during registration. Previous local registration retained; refresh before retrying.':
            '등록 중 기기 또는 전달 상태가 바뀌었습니다. 기존 로컬 등록은 유지됩니다. 새로고침 후 다시 시도하세요.',
        'No Rethink device is linked to this IP': '이 IP에 연결된 Rethink 기기가 없습니다. 기기 연결을 확인하세요.',
        'Rethink device is not connected': 'Rethink 기기가 연결되지 않았습니다. 연결 상태를 확인하세요.',
        'Bridge is not configured': 'LG Bridge가 설정되지 않았습니다. 연동 설정을 확인하세요.',
        'Bridge is not configured for this device': '이 기기의 LG Bridge가 설정되지 않았습니다.',
        'Router SSH settings are not configured': '공유기 SSH 설정이 없습니다. 공유기 설정을 저장하세요.',
        'Not logged in': 'LG 계정에 로그인한 뒤 다시 시도하세요.',
        'Device type must be specified': 'LG 기기 유형을 입력한 뒤 다시 시도하세요.',
        'Mode approval is stale. Refresh and approve again.':
            '모드 변경 승인이 만료되었습니다. 새로고침한 뒤 다시 승인하세요.',
    }
    const diagnosticFallbacks = {
        router: '공유기 작업을 완료하지 못했습니다. 연결과 설정을 확인한 뒤 다시 시도하세요.',
        ssh: '공유기 SSH 상태를 확인하지 못했습니다. 연결과 설정을 확인하세요.',
        bridge: 'LG Bridge 작업을 완료하지 못했습니다. 등록 및 연결 상태를 확인하세요.',
        account: 'LG 계정 작업을 완료하지 못했습니다. 로그인 상태를 확인한 뒤 다시 시도하세요.',
        status: '상태 알림을 확인할 수 없습니다. 새로고침하여 최신 상태를 확인하세요.',
    }
    function diagnostic(value, context = 'status') {
        const raw = (value instanceof Error ? value.message : String(value ?? '')).trim()
        if (!raw) return ''
        if (locale !== 'ko') return raw
        if (Object.hasOwn(diagnosticMessages, raw)) return diagnosticMessages[raw]
        const approval =
            /^Review and explicitly approve (dnat|local) → (dnat|local) before changing mode\. Acknowledge power-removal Wi-Fi-module reset and target-mode appliance certificate enrollment, then send modeTransition \{from, to, acknowledged: true\} matching the current and requested modes\. Approval does not verify physical preparation\. Refresh if the mode has changed\.$/.exec(
                raw,
            )
        if (approval && approval[1] !== approval[2])
            return '모드 변경 내용을 다시 확인하고 전원 제거 초기화와 대상 모드의 기기 인증서 등록을 승인하세요. 상태가 바뀌었다면 새로고침하세요.'
        return diagnosticFallbacks[context] || diagnosticFallbacks.status
    }
    const textNodes = new WeakMap()
    function writeText(element, value) {
        if (element.nodeType === Node.TEXT_NODE) {
            element.textContent = value
            return
        }
        let text = textNodes.get(element)
        if (!text || text.parentNode !== element) {
            element.textContent = ''
            text = document.createTextNode('')
            element.append(text)
            textNodes.set(element, text)
        }
        text.textContent = value
    }
    function bind(element, read, attribute) {
        if (bindings.size % 128 === 0) for (const [node] of bindings) if (!node.isConnected) bindings.delete(node)
        let entries = bindings.get(element)
        if (!entries) {
            entries = new Map()
            bindings.set(element, entries)
        }
        entries.set(attribute || 'textContent', read)
        if (attribute) element.setAttribute(attribute, read())
        else writeText(element, read())
        return element
    }
    function update() {
        document.documentElement.lang = locale
        for (const [element, entries] of bindings) {
            if (!element.isConnected) {
                bindings.delete(element)
                continue
            }
            for (const [attribute, read] of entries) {
                if (attribute === 'textContent') writeText(element, read())
                else element.setAttribute(attribute, read())
            }
        }
        for (const control of document.querySelectorAll('#language')) control.value = locale
        for (const listener of listeners) listener()
    }
    function setLocale(value) {
        if (value !== 'ko' && value !== 'en') return
        locale = value
        try {
            localStorage.setItem('rethink.language', locale)
        } catch {}
        update()
    }
    const modalInstances = new WeakMap()
    function modal(element) {
        if (!modalInstances.has(element)) {
            let previous
            const close = () => {
                element.close()
                previous?.focus()
            }
            const instance = {
                open() {
                    previous = document.activeElement
                    element.showModal()
                    ;(element.querySelector('button, input, select, a') || element).focus()
                },
                close,
            }
            element.addEventListener('cancel', (event) => {
                event.preventDefault()
                close()
            })
            for (const button of element.querySelectorAll('.modal-close'))
                button.addEventListener('click', (event) => {
                    event.preventDefault()
                    close()
                })
            modalInstances.set(element, instance)
        }
        return modalInstances.get(element)
    }
    document.addEventListener('DOMContentLoaded', () => {
        for (const element of document.querySelectorAll('[data-i18n]')) {
            const key = element.textContent.trim().replace(/\s+/g, ' ')
            bind(element, () => t(key))
        }
        for (const attribute of ['aria-label', 'title', 'placeholder']) {
            for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
                const key = element.getAttribute(attribute)
                bind(element, () => t(key), attribute)
            }
        }
        const picker = document.getElementById('language')
        picker?.addEventListener('change', () => setLocale(picker.value))
        for (const trigger of document.querySelectorAll('.modal-trigger'))
            trigger.addEventListener('click', () => {
                if (!trigger.disabled) modal(document.getElementById(trigger.dataset.target)).open()
            })
        for (const element of document.querySelectorAll('dialog.modal')) {
            const heading = element.querySelector('h2')
            if (heading) {
                heading.id ||= `${element.id}-title`
                element.setAttribute('aria-labelledby', heading.id)
            }
        }
        update()
        if (!location.pathname.startsWith('/__management/')) void manageSession()
    })
    window.addEventListener('storage', (event) => {
        if (event.key === 'rethink.language') setLocale(event.newValue)
    })
    let permitted = false
    let sessionEnabled = false
    async function manageSession() {
        let view,
            epoch = 0,
            warning,
            countdown,
            generationShown,
            timer,
            deadline = 0,
            checkFailed = false
        const bar = document.createElement('div')
        bar.className = 'session-bar'
        const status = document.createElement('span')
        status.setAttribute('role', 'status')
        const logout = document.createElement('button')
        bind(logout, () => t('Log out'))
        bar.append(status, logout)
        const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('rethink.session') : undefined
        function lock(value) {
            permitted = !value
            for (const main of document.querySelectorAll('main, dialog:not(#session-warning)')) main.inert = value
            window.dispatchEvent(new Event('management-session'))
        }
        function login() {
            ++epoch
            clearTimeout(timer)
            lock(true)
            location.replace(`/__management/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`)
        }
        async function out() {
            ++epoch
            lock(true)
            try {
                await fetch('/__management/logout', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: '{}',
                })
            } finally {
                channel?.postMessage('changed')
                login()
            }
        }
        logout.onclick = out
        async function refresh(gate = false) {
            const request = ++epoch
            const requestedAt = performance.now()
            if (gate || !view) lock(true)
            try {
                const response = await fetch('/__management/session', { cache: 'no-store' })
                if (request !== epoch) return
                if (response.status === 404 && !sessionEnabled) {
                    lock(false)
                    bar.remove()
                    return
                } // Explicit legacy Basic compatibility.
                if (response.status === 401) {
                    sessionEnabled = true
                    return login()
                }
                if (!response.ok) throw new Error('Session unavailable')
                const next = await response.json()
                if (request !== epoch) return
                if (!next.authenticated || !Number.isFinite(next.remainingMs) || !Number.isInteger(next.generation)) {
                    throw new Error('Invalid session response')
                }
                if (view && next.generation !== view.generation) {
                    warning?.close()
                    warning?.remove()
                    warning = undefined
                    countdown = undefined
                    generationShown = undefined
                }
                checkFailed = false
                view = next
                sessionEnabled = true
                if (!bar.isConnected) document.querySelector('header').after(bar)
                deadline = requestedAt + view.remainingMs
                lock(false)
                tick()
            } catch {
                if (request !== epoch) return
                checkFailed = true
                lock(true)
                if (!bar.isConnected) document.querySelector('header').after(bar)
                bind(status, () => t('Session check failed. Controls are locked.'))
            }
        }
        function tick() {
            clearTimeout(timer)
            if (!view) return
            const remaining = Math.max(0, deadline - performance.now())
            if (!remaining) return login()
            if (!checkFailed)
                bind(status, () => `${t('Session')} · ${t('{0} seconds remaining', [Math.ceil(remaining / 1000)])}`)
            if (remaining <= view.warningMs && generationShown !== view.generation) {
                generationShown = view.generation
                const promptGeneration = view.generation
                const savedFocus = document.activeElement
                warning?.remove()
                warning = document.createElement('dialog')
                warning.id = 'session-warning'
                warning.setAttribute('aria-labelledby', 'session-warning-title')
                const title = document.createElement('h2')
                title.id = 'session-warning-title'
                bind(title, () => t('Session expires soon'))
                countdown = document.createElement('p')
                countdown.setAttribute('role', 'status')
                const extend = document.createElement('button')
                bind(extend, () => t('Extend session'))
                const exit = document.createElement('button')
                bind(exit, () => t('Log out'))
                exit.onclick = out
                const dismiss = document.createElement('button')
                bind(dismiss, () => t('Dismiss'))
                const dialog = warning
                const close = () => {
                    dialog.close()
                    savedFocus?.focus()
                }
                dismiss.onclick = close
                warning.oncancel = (event) => {
                    event.preventDefault()
                    close()
                }
                extend.onclick = async () => {
                    extend.disabled = true
                    try {
                        const response = await fetch('/__management/extend', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ generation: promptGeneration }),
                        })
                        if (response.status === 401) return login()
                        if (!response.ok && response.status !== 409) throw new Error('Extension failed')
                        close()
                        channel?.postMessage('changed')
                        await refresh()
                    } catch {
                        lock(true)
                        await refresh()
                    } finally {
                        extend.disabled = false
                    }
                }
                warning.append(title, countdown, extend, exit, dismiss)
                document.body.append(warning)
                warning.showModal()
                extend.focus()
            }
            if (countdown) bind(countdown, () => t('{0} seconds remaining', [Math.ceil(remaining / 1000)]))
            timer = setTimeout(tick, 500)
        }
        channel?.addEventListener('message', () => void refresh())
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) void refresh(true)
            else if (sessionEnabled) {
                ++epoch
                lock(true)
            }
        })
        window.addEventListener('pageshow', () => void refresh(true))
        await refresh(true)
        setInterval(() => {
            if (!document.hidden) void refresh()
        }, 30_000)
    }
    return {
        t,
        diagnostic,
        bind,
        textNode: (read) => bind(document.createTextNode(''), read),
        setLocale,
        get locale() {
            return locale
        },
        date: (value) => new Date(value).toLocaleString(locale),
        time: (value) => new Date(value).toLocaleTimeString(locale),
        onChange: (listener) => listeners.add(listener),
        allowed: () => permitted,
        modal,
    }
})()
// Compatibility is limited to the native dialog calls retained by the existing pages.
const M = {
    Modal: {
        init(elements) {
            for (const element of elements) UI.modal(element)
        },
        getInstance: UI.modal,
    },
    updateTextFields() {},
}
