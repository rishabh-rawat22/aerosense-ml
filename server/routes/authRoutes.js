const express = require('express');
const { body }  = require('express-validator');
const router    = express.Router();
const { register, login, getMe, updateDistrict, saveLocation } = require('../controllers/authController');
const { protect }     = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimiter');

const registerRules = [
  body('name').trim().isLength({ min: 2, max: 50 }).withMessage('Name must be 2–50 characters'),
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').isLength({ min: 6 }).withMessage('Password must be at least 6 characters'),
];

const loginRules = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email required'),
  body('password').notEmpty().withMessage('Password is required'),
];

router.post('/register', authLimiter, registerRules, register);
router.post('/login',    authLimiter, loginRules,    login);
router.get('/me',                     protect,        getMe);
router.patch('/update-district',      protect,        updateDistrict);
router.post('/save-location',         protect,        saveLocation);

module.exports = router;
