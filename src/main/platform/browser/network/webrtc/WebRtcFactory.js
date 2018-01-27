class WebRtcFactory {
    static newPeerConnection(configuration) {
        return new RTCPeerConnection(configuration);
    }

    static newSessionDescription(rtcSessionDescriptionInit) {
        return new RTCSessionDescription(rtcSessionDescriptionInit);
    }

    static newIceCandidate(rtcIceCandidateInit) {
        return new RTCIceCandidate(rtcIceCandidateInit);
    }
}
Class.register(WebRtcFactory);
