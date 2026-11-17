import array
import collections
import threading
import time


class InputReady:
    def __init__(self, receiver, clock=time.monotonic):
        self.receiver, self.clock = receiver, clock
        self.ready = threading.Event()
        self.lock = threading.RLock()
        self.armed_at = None
        self.closed = False
        self.stable = 0
        self.dropped = 0
        self.clipped = 0
        self.max_mean = 0.0
        self.count = self.total = self.bucket_clipped = 0
        self.voiced = False
        self.buckets = collections.deque(maxlen=24)
        self.rejected = {"clipping": 0, "dcOffset": 0, "vadSpeech": 0}
        self.completed = 0
        self.arm_retries = 0

    def snapshot(self):
        with self.lock:
            return {"discardedSeconds": round(self.dropped / 32000, 3),
                    "discardedClippedSamples": self.clipped,
                    "maximumBucketAbsMean": round(self.max_mean, 5),
                    "stableQuietSeconds": round(self.stable * 0.25, 3),
                    "ready": self.ready.is_set(), "armRetries": self.arm_retries,
                    "rejectedBuckets": dict(self.rejected),
                    "partialBucket": {"samples": self.count, "vadSpeech": self.voiced,
                                      "clippedSamples": self.bucket_clipped,
                                      "absMeanBudget": round(abs(self.total) / 4000 / 32768, 5)},
                    "buckets": [dict(bucket) for bucket in self.buckets]}

    def feed(self, pcm, voiced, captured_at=None):
        with self.lock:
            if self.closed:
                return
            if not isinstance(pcm, bytes) or not pcm or len(pcm) % 2:
                raise ValueError("Invalid warm-up capture frame")
            when = self.clock() if captured_at is None else captured_at
            if self.armed_at is not None:
                if when >= self.armed_at:
                    self.receiver.feed(pcm, voiced, captured_at=when)
                return
            self.dropped += len(pcm)
            samples = array.array("h", pcm)
            start = 0
            while start < len(samples):
                end = min(len(samples), start + 4000 - self.count)
                block = samples[start:end]
                clips = sum(abs(value) >= 32760 for value in block)
                self.count += len(block)
                self.total += sum(block)
                self.clipped += clips
                self.bucket_clipped += clips
                self.voiced = self.voiced or voiced
                if self.count == 4000:
                    mean = abs(self.total / self.count / 32768)
                    self.max_mean = max(self.max_mean, mean)
                    good = not self.bucket_clipped and mean <= 0.01 and not self.voiced
                    self.stable = self.stable + 1 if good else 0
                    self.completed += 1
                    self.rejected["clipping"] += bool(self.bucket_clipped)
                    self.rejected["dcOffset"] += mean > 0.01
                    self.rejected["vadSpeech"] += self.voiced
                    self.buckets.append({"audioSeconds": self.completed * 0.25,
                                         "absMean": round(mean, 5),
                                         "clippedSamples": self.bucket_clipped,
                                         "vadSpeech": self.voiced,
                                         "stableQuietSeconds": self.stable * 0.25})
                    if self.stable >= 3:
                        self.ready.set()
                    else:
                        self.ready.clear()
                    self.count = self.total = self.bucket_clipped = 0
                    self.voiced = False
                start = end

    def arm(self):
        with self.lock:
            if self.closed or self.armed_at is not None:
                raise RuntimeError("Input readiness gate is not active")
            # Use the same quarter-second offset budget, not a noisier partial-frame mean.
            partial_offset = abs(self.total) / 4000 / 32768
            if (not self.ready.is_set() or self.voiced
                    or self.bucket_clipped or partial_offset > 0.01):
                self.arm_retries += 1
                self.stable = 0
                self.ready.clear()
                return None
            self.armed_at = self.clock()
            return {"discardedSeconds": round(self.dropped / 32000, 3),
                    "discardedClippedSamples": self.clipped,
                    "maximumBucketAbsMean": round(self.max_mean, 5),
                    "stableQuietSeconds": 0.75}

    def close(self):
        with self.lock:
            self.closed = True
            self.ready.clear()
            self.count = self.total = self.bucket_clipped = 0
            self.voiced = False
        self.receiver.close()
