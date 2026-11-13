"""Camera frames to aligned face + mouth crops, once per frame, entirely in memory."""
import cv2
import numpy as np
import mediapipe as mp


class Crops:
    """FLARE's input: the aligned face and the mouth, 2 x 88 x 88."""

    def __init__(self):
        self.mesh = mp.solutions.face_mesh.FaceMesh(max_num_faces=1, refine_landmarks=False,
                                                   min_detection_confidence=0.6, min_tracking_confidence=0.6)
        self.points = None
        self.framing = 'Looking for your face'

    def close(self):
        self.mesh.close()

    def reset(self):
        self.points = None

    def __call__(self, bgr):
        pts = self.landmarks(bgr)
        return None if pts is None else self.crop(bgr, pts)

    def landmarks(self, bgr):
        """The face mesh's points in pixels, or None (with the reason in `framing`)."""
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        result = self.mesh.process(rgb)
        if not result.multi_face_landmarks:
            self.reset()
            self.framing = 'Face not visible — adjust the screen or camera'
            return None
        h, w = bgr.shape[:2]
        pts = np.array([(p.x * w, p.y * h) for p in result.multi_face_landmarks[0].landmark], dtype=np.float32)
        lips = pts[[61, 291, 0, 17]]
        if not ((lips[:, 0] >= 3).all() and (lips[:, 0] < w - 3).all()
                and (lips[:, 1] >= 3).all() and (lips[:, 1] < h - 3).all()):
            self.framing = 'Mouth is outside the camera view — adjust the screen'
            return None
        if np.linalg.norm(pts[61] - pts[291]) < 35:
            self.framing = 'Mouth is small in the camera — move closer'
        else:
            self.framing = 'Mouth detected — keep it in view'
        return pts

    def crop(self, bgr, pts):
        # Stabilize eye/nose alignment while preserving current lip motion.
        anchors = np.array([(pts[33]+pts[133])/2, (pts[362]+pts[263])/2, pts[1]])
        self.points = anchors if self.points is None else 0.65 * anchors + 0.35 * self.points
        reference = np.array([[86, 101], [170, 101], [128, 145]], dtype=np.float32)
        matrix = cv2.getAffineTransform(self.points.astype(np.float32), reference)
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        aligned = cv2.warpAffine(gray, matrix, (256, 256), borderMode=cv2.BORDER_REPLICATE)
        mouth = (pts[61] + pts[291] + pts[0] + pts[17]) / 4
        mouth = matrix[:, :2] @ mouth + matrix[:, 2]
        lip = cv2.getRectSubPix(aligned, (96, 96), tuple(mouth.astype(float)))
        face = cv2.resize(aligned, (96, 96), interpolation=cv2.INTER_AREA)
        # Training uses resize to 96, center crop to 88, mean=.421, std=.165.
        return np.stack([face[4:92, 4:92], lip[4:92, 4:92]])


# The face mesh's points for the 68-point face (USR 2.0's preprocessing/landmarks_detector.py).
MESH_TO_68 = [
    162, 234, 93, 58, 172, 136, 149, 148, 152, 377, 378, 365, 397, 288, 323, 454, 389,  # jaw
    70, 63, 105, 66, 107, 336, 296, 334, 293, 301,  # eyebrows
    168, 197, 5, 4, 75, 97, 2, 326, 305,  # nose
    33, 160, 158, 133, 153, 144, 362, 385, 387, 263, 373, 380,  # eyes
    61, 39, 37, 0, 267, 269, 291, 321, 314, 17, 84, 91,  # outer lips
    78, 82, 13, 312, 308, 317, 14, 87,  # inner lips
]
# Nose, eye corners and mouth corners: what the face is aligned by.
STABLE = [28, 33, 36, 39, 42, 45, 48, 54]


class MouthCrops(Crops):
    """USR 2.0's input: the mouth, 88 x 88, cut as its training data was (preprocessing/
    video_preprocess.py). The stable points go to the mean face at 256 px; 96 px around the
    lips is cut and the centre 88 kept. FLARE's alignment draws the face about 1.55x larger, so
    USR 2.0 needs this one. It averages the landmarks over 13 frames centred on each frame; live
    there are only past frames, so they are smoothed over the recent ones instead."""

    def __init__(self, mean_face):
        super().__init__()
        self.reference = np.load(mean_face)[STABLE].astype(np.float32)
        self.smoothed = None

    def reset(self):
        super().reset()
        self.smoothed = None

    def crop(self, bgr, pts):
        face = pts[MESH_TO_68]
        self.smoothed = face if self.smoothed is None else 0.5 * face + 0.5 * self.smoothed
        # The smoothed shape, where the face is now.
        smoothed = self.smoothed + (face.mean(0) - self.smoothed.mean(0))
        matrix, _ = cv2.estimateAffinePartial2D(smoothed[STABLE], self.reference, method=cv2.LMEDS)
        if matrix is None:
            return None
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        aligned = cv2.warpAffine(gray, matrix, (256, 256), flags=cv2.INTER_LINEAR,
                                 borderMode=cv2.BORDER_CONSTANT, borderValue=0)
        cx, cy = (smoothed[48:68] @ matrix[:, :2].T + matrix[:, 2]).mean(0)
        x = int(min(max(round(cx - 48), 0), 256 - 96))
        y = int(min(max(round(cy - 48), 0), 256 - 96))
        return aligned[y + 4:y + 92, x + 4:x + 92]
