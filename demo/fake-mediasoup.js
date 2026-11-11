// Demo only. Stands in for the real WebRTC library so the player client can
// be shown in any browser with no server and no microphone.
function silentTrack() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    return new Ctx().createMediaStreamDestination().stream.getAudioTracks()[0];
  } catch {
    return null;
  }
}

class FakeTransport {
  on() {}
  close() {}
  async produce() {
    return { paused: false, pause() { this.paused = true; }, resume() { this.paused = false; }, async replaceTrack() {}, close() {} };
  }
  async consume() {
    return { track: silentTrack(), close() {} };
  }
}

export class Device {
  async load() {}
  get rtpCapabilities() { return {}; }
  createSendTransport() { return new FakeTransport(); }
  createRecvTransport() { return new FakeTransport(); }
}
