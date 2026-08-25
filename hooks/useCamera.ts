'use client';

/**
 * Camera lifecycle for the capture screens.
 *
 * Deliberately hand-rolled rather than pulled from a library: the only tricky
 * parts are (a) never leaking a MediaStream when the user switches lens or
 * navigates away, and (b) surviving React's double-invoked effects in
 * development. Both are handled with a generation counter, so a stream that
 * arrives after its request was superseded is stopped immediately instead of
 * being attached to a stale element.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export type CameraStatus =
  | 'idle'
  | 'starting'
  | 'live'
  | 'denied'
  | 'unavailable'
  | 'error';

export type Facing = 'user' | 'environment';

export interface UseCameraResult {
  videoRef: React.RefObject<HTMLVideoElement>;
  status: CameraStatus;
  error: string | null;
  facing: Facing;
  /** True once we know the device exposes more than one camera. */
  canSwitch: boolean;
  /** The preview is mirrored for the selfie lens; capture must un-mirror. */
  mirrored: boolean;
  start: () => void;
  stop: () => void;
  switchCamera: () => void;
}

const CONSTRAINTS = (facing: Facing): MediaStreamConstraints => ({
  audio: false,
  video: {
    facingMode: { ideal: facing },
    // Ask for a tall frame: a standing body wants portrait, and more vertical
    // pixels directly improves the crown-to-sole scale estimate.
    width: { ideal: 1080 },
    height: { ideal: 1920 },
    frameRate: { ideal: 30, max: 30 },
  },
});

export function useCamera(initialFacing: Facing = 'environment'): UseCameraResult {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const genRef = useRef(0);

  const [facing, setFacing] = useState<Facing>(initialFacing);
  const [status, setStatus] = useState<CameraStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [canSwitch, setCanSwitch] = useState(false);

  const teardown = useCallback(() => {
    genRef.current++;
    const stream = streamRef.current;
    streamRef.current = null;
    if (stream) for (const track of stream.getTracks()) track.stop();
    const video = videoRef.current;
    if (video) video.srcObject = null;
  }, []);

  const open = useCallback(
    async (want: Facing) => {
      if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
        setStatus('unavailable');
        setError('This browser cannot access a camera. Upload a photo instead.');
        return;
      }
      teardown();
      const gen = genRef.current;
      setStatus('starting');
      setError(null);

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia(CONSTRAINTS(want));
      } catch (err) {
        if (gen !== genRef.current) return;
        const name = err instanceof DOMException ? err.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          setStatus('denied');
          setError(
            'Camera access was blocked. Allow it in your browser settings, or upload a photo.',
          );
        } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
          setStatus('unavailable');
          setError('No camera was found on this device. Upload a photo instead.');
        } else {
          setStatus('error');
          setError(
            err instanceof Error ? err.message : 'The camera could not be started.',
          );
        }
        return;
      }

      if (gen !== genRef.current) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }

      streamRef.current = stream;
      const video = videoRef.current;
      if (!video) {
        for (const track of stream.getTracks()) track.stop();
        streamRef.current = null;
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // Autoplay can reject if the element is detached mid-start; the stream
        // is still live and the next user gesture will resume it.
      }
      if (gen !== genRef.current) return;
      setStatus('live');

      // Labels are only populated after a grant, so enumerate now.
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cams = devices.filter((d) => d.kind === 'videoinput');
        if (gen === genRef.current) setCanSwitch(cams.length > 1);
      } catch {
        /* enumeration is a nicety, not a requirement */
      }
    },
    [teardown],
  );

  const start = useCallback(() => {
    void open(facing);
  }, [facing, open]);

  const switchCamera = useCallback(() => {
    setFacing((f) => (f === 'user' ? 'environment' : 'user'));
  }, []);

  // Re-open on lens change; always tear down on unmount.
  useEffect(() => {
    void open(facing);
    return teardown;
  }, [facing, open, teardown]);

  // Free the camera while the tab is hidden — iOS suspends the stream anyway
  // and holding it keeps the indicator lit.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') teardown();
      else if (status !== 'denied' && status !== 'unavailable') void open(facing);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [facing, open, status, teardown]);

  return {
    videoRef,
    status,
    error,
    facing,
    canSwitch,
    mirrored: facing === 'user',
    start,
    stop: teardown,
    switchCamera,
  };
}
