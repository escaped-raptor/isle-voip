// The media relay (an SFU, built on mediasoup).
// Every player sends audio only to this server and receives audio only from
// it, encrypted with DTLS-SRTP. Players never connect to each other, so one
// player can never learn another player's IP address.
import * as mediasoup from 'mediasoup';

export async function createSfu({ listenIp = '0.0.0.0', announcedAddress, port = 40000 }) {
  const worker = await mediasoup.createWorker({ logLevel: 'warn' });
  worker.on('died', () => {
    console.error('[media] The media worker stopped unexpectedly. Exiting so a supervisor can restart the server.');
    process.exit(1);
  });

  const info = (protocol) => ({ protocol, ip: listenIp, announcedAddress: announcedAddress || undefined, port });
  const webRtcServer = await worker.createWebRtcServer({ listenInfos: [info('udp'), info('tcp')] });

  const router = await worker.createRouter({
    mediaCodecs: [{ kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }]
  });

  return {
    router,
    rtpCapabilities: router.rtpCapabilities,
    async createTransport() {
      return router.createWebRtcTransport({ webRtcServer, enableUdp: true, enableTcp: true, preferUdp: true });
    },
    close() {
      worker.close();
    }
  };
}
