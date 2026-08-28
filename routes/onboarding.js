const express = require('express');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getOnboardingStatus } = require('../services/onboardingService');

const router = express.Router();

router.use(requireAuth);

router.get('/status', (req, res) => {
  res.json(getOnboardingStatus(db, req.user.id));
});

module.exports = router;
