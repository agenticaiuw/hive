"""Camera frames to aligned face + mouth crops, once per frame, entirely in memory."""
import cv2
import numpy as np
import mediapipe as mp


class Crops:
    def __init__(self):
        self.mesh = mp.solutions.face_mesh.FaceMesh(max_num_faces=1, refine_landmarks=False,
                                                   min_detection_confidence=0.6, min_tracking_confidence=0.6)
        self.points = None

    def close(self):
        self.mesh.close()

    def __call__(self, bgr):
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        result = self.mesh.process(rgb)
        if not result.multi_face_landmarks:
            self.points = None
            return None
        h, w = bgr.shape[:2]
        pts = np.array([(p.x * w, p.y * h) for p in result.multi_face_landmarks[0].landmark], dtype=np.float32)
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
