const webrtc = require('wrtc');

class WebRtcFactory {
    static newPeerConnection(configuration) {
        return new webrtc.RTCPeerConnection(configuration);
    }

    static newSessionDescription(rtcSessionDescriptionInit) {
        return new webrtc.RTCSessionDescription(rtcSessionDescriptionInit);
    }

    static newIceCandidate(rtcIceCandidateInit) {
        return new webrtc.RTCIceCandidate(rtcIceCandidateInit);
    }
}
Class.register(WebRtcFactory);
