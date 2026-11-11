"""Check that off-screen mouths are rejected and framing warnings are exposed."""
import sys
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock

import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from lipread_vision import Crops


class FramingTest(unittest.TestCase):
    def setUp(self):
        self.crops = Crops()
        self.crops.mesh.close()
        self.crops.mesh = Mock()
        self.points = [SimpleNamespace(x=.5, y=.5) for _ in range(468)]
        for i, x, y in [(33,.30,.30),(133,.40,.30),(362,.60,.30),(263,.70,.30),
                        (1,.50,.50),(61,.40,.70),(291,.60,.70),(0,.50,.68),(17,.50,.72)]:
            self.points[i] = SimpleNamespace(x=x,y=y)
        self.crops.mesh.process.return_value = SimpleNamespace(multi_face_landmarks=[SimpleNamespace(landmark=self.points)])
        self.image = np.zeros((480, 640, 3), dtype=np.uint8)

    def test_visible_mouth_is_cropped(self):
        self.assertEqual(self.crops(self.image).shape, (2, 88, 88))
        self.assertIn('Mouth detected', self.crops.framing)

    def test_mouth_outside_frame_is_not_fed_to_model(self):
        self.points[17].y = 1.1
        self.assertIsNone(self.crops(self.image))
        self.assertIn('outside', self.crops.framing)

    def test_missing_face_shows_warning(self):
        self.crops.mesh.process.return_value = SimpleNamespace(multi_face_landmarks=None)
        self.assertIsNone(self.crops(self.image))
        self.assertIn('not visible', self.crops.framing)


if __name__ == '__main__':
    unittest.main()
