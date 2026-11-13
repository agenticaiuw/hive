"""USR 2.0's mouth crop and the worker's choice of model, without the model or a camera."""
import os
import sys
import tempfile
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from lipread_vision import MESH_TO_68, MouthCrops
import lipread_worker

WEIGHTS = 'huge_high_resource_lrs2lrs3vox2avsp.pth'


class MouthCropTest(unittest.TestCase):
    """A face whose points are the mean face, scaled and moved: the mouth lands mid-crop."""

    def setUp(self):
        rng = np.random.default_rng(7)
        self.mean_face = rng.uniform(60, 200, (68, 2))
        self.mean_face[48:68] = rng.uniform((100, 150), (156, 190), (20, 2))
        self.dir = tempfile.TemporaryDirectory()
        path = Path(self.dir.name) / 'mean_face.npy'
        np.save(path, self.mean_face)
        self.crops = MouthCrops(path)
        self.crops.mesh.close()
        self.crops.mesh = Mock()
        face = self.mean_face * 0.6 + (150, 100)
        points = [SimpleNamespace(x=.5, y=.5) for _ in range(468)]
        for index, (x, y) in zip(MESH_TO_68, face):
            points[index] = SimpleNamespace(x=x / 640, y=y / 480)
        self.crops.mesh.process.return_value = SimpleNamespace(multi_face_landmarks=[SimpleNamespace(landmark=points)])
        self.image = np.zeros((480, 640, 3), dtype=np.uint8)
        mx, my = face[48:68].mean(0).round().astype(int)
        self.image[my - 4:my + 5, mx - 4:mx + 5] = 255

    def tearDown(self):
        self.dir.cleanup()

    def test_the_mouth_is_in_the_middle_of_the_crop(self):
        crop = self.crops(self.image)
        self.assertEqual(crop.shape, (88, 88))
        self.assertTrue((crop[41:48, 41:48] > 200).all(), crop[38:51, 38:51])
        self.assertEqual(crop[:20].max(), 0)

    def test_a_lost_face_starts_smoothing_again(self):
        self.crops(self.image)
        self.assertIsNotNone(self.crops.smoothed)
        self.crops.mesh.process.return_value = SimpleNamespace(multi_face_landmarks=None)
        self.assertIsNone(self.crops(self.image))
        self.assertIsNone(self.crops.smoothed)


class ModelChoiceTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        home = Path(self.dir.name)
        (home / 'flare').mkdir()
        self.usr2 = home / 'usr2'
        self.env = patch.dict(os.environ, {'LIPREAD_FLARE_DIR': str(home / 'flare')})
        self.env.start()
        os.environ.pop('LIPREAD_MODEL', None)
        os.environ.pop('LIPREAD_USR2_DIR', None)
        self.models = patch('lipread_usr2.Usr2', lambda root: ('usr2', Path(root))), \
            patch('lipread_flare.Flare', lambda root: ('flare', Path(root)))
        for model in self.models:
            model.start()

    def tearDown(self):
        for model in self.models:
            model.stop()
        self.env.stop()
        self.dir.cleanup()

    def install_usr2(self):
        (self.usr2 / 'espnet/nets/pytorch_backend').mkdir(parents=True)
        (self.usr2 / 'weights').mkdir()
        (self.usr2 / 'weights' / WEIGHTS).write_bytes(b'')

    def test_flare_unless_usr2_is_asked_for(self):
        self.install_usr2()
        self.assertEqual(lipread_worker.load_model()[0], 'flare')
        os.environ['LIPREAD_MODEL'] = 'usr2'
        self.assertEqual(lipread_worker.load_model(), ('usr2', self.usr2))


if __name__ == '__main__':
    unittest.main()
