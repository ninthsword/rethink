import { diagnosticCLI } from './mqtt-diagnostic'

if (process.argv.length < 7) {
    console.warn(
        `사용법:
	tsx packet-sender-device.ts TLS호스트[:포트] device-uuid cmd type data
`,
    )
    process.exit()
}

const [mqttHostname, deviceId, cmd, type, data] = process.argv.slice(2)
const messagestr = JSON.stringify({
    did: deviceId,
    mid: Date.now(),
    cmd: cmd,
    type: Number(type),
    data: JSON.parse(data),
})
console.log(messagestr)

const client = diagnosticCLI(mqttHostname, deviceId, true)

client.on('connect', () => {
    client.publish(`lime/devices/${deviceId}`, `${messagestr} `, { qos: 1 }, (error) => {
        if (!error) client.end()
    })
})
