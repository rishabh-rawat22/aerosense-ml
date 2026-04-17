const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const User = require('../models/User');

const signToken = (userId) =>
  jwt.sign({ id: userId }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });

// POST /api/auth/register
const register = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const { name, email, password } = req.body;
  try {
    const exists = await User.findOne({ email });
    if (exists) return res.status(409).json({ success: false, error: 'Email already registered.' });

    const user  = await User.create({ name, email, password });
    const token = signToken(user._id);

    res.status(201).json({
      success: true,
      token,
      user: { id: user._id, name: user.name, email: user.email, savedLocations: user.savedLocations, lastKnownDistrict: user.lastKnownDistrict },
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ success: false, error: 'Server error during registration.' });
  }
};

// POST /api/auth/login
const login = async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  const { email, password } = req.body;
  try {
    const user = await User.findOne({ email }).select('+password');
    if (!user) return res.status(401).json({ success: false, error: 'Invalid email or password.' });

    const ok = await user.comparePassword(password);
    if (!ok) return res.status(401).json({ success: false, error: 'Invalid email or password.' });

    const token = signToken(user._id);
    res.json({
      success: true,
      token,
      user: { id: user._id, name: user.name, email: user.email, savedLocations: user.savedLocations, lastKnownDistrict: user.lastKnownDistrict },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, error: 'Server error during login.' });
  }
};

// GET /api/auth/me
const getMe = (req, res) => {
  res.json({
    success: true,
    user: { id: req.user._id, name: req.user.name, email: req.user.email, savedLocations: req.user.savedLocations, lastKnownDistrict: req.user.lastKnownDistrict },
  });
};

// PATCH /api/auth/update-district
const updateDistrict = async (req, res) => {
  try {
    const { district } = req.body;
    if (!district) return res.status(400).json({ success: false, error: 'District is required.' });
    await User.findByIdAndUpdate(req.user._id, { lastKnownDistrict: district });
    res.json({ success: true, message: 'District updated.' });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error.' });
  }
};

// POST /api/auth/save-location
const saveLocation = async (req, res) => {
  try {
    const { district, state, label, lat, lon } = req.body;
    if (!district) return res.status(400).json({ success: false, error: 'District is required.' });

    const user = await User.findById(req.user._id);
    if (user.savedLocations.length >= 10) {
      return res.status(400).json({ success: false, error: 'Maximum 10 saved locations allowed.' });
    }
    user.savedLocations.push({ district, state, label, lat, lon });
    await user.save();
    res.json({ success: true, savedLocations: user.savedLocations });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Server error.' });
  }
};

module.exports = { register, login, getMe, updateDistrict, saveLocation };
