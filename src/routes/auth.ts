import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { User } from '@ai-interview/db';
import { AuthError } from '../constants/errors';
import { authenticate } from '../middleware/authenticate';

const router = Router();

const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

// POST /auth/register
router.post('/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: AuthError.MISSING_FIELDS });
    }

    const existing = await User.findOne({ email: email.toLowerCase().trim() });
    if (existing) return res.status(409).json({ error: AuthError.EMAIL_TAKEN });

    const hashed = await bcrypt.hash(password, 12);
    const user = await User.create({ name, email, password: hashed });

    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email, role: user.role },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' },
    );

    res.cookie('token', token, COOKIE_OPTIONS);
    res.status(201).json({ id: user._id, name: user.name, email: user.email, role: user.role });
  } catch {
    res.status(500).json({ error: AuthError.SERVER_ERROR });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: AuthError.MISSING_FIELDS });
    }

    const user = await User.findOne({ email: email.toLowerCase().trim() });
    if (!user) return res.status(401).json({ error: AuthError.INVALID_CREDENTIALS });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: AuthError.INVALID_CREDENTIALS });

    const token = jwt.sign(
      { userId: user._id.toString(), email: user.email, role: user.role },
      process.env.JWT_SECRET!,
      { expiresIn: '7d' },
    );

    res.cookie('token', token, COOKIE_OPTIONS);
    res.json({ id: user._id, name: user.name, email: user.email, role: user.role });
  } catch {
    res.status(500).json({ error: AuthError.SERVER_ERROR });
  }
});

// POST /auth/logout
router.post('/logout', (_req, res) => {
  res.clearCookie('token', {
    httpOnly: COOKIE_OPTIONS.httpOnly,
    secure: COOKIE_OPTIONS.secure,
    sameSite: COOKIE_OPTIONS.sameSite,
  });
  res.json({ success: true });
});

// GET /auth/me — verify session and return current user
router.get('/me', authenticate, async (req, res) => {
  try {
    const user = await User.findById(req.user!.userId).select('-password');
    if (!user) return res.status(401).json({ error: AuthError.UNAUTHORIZED });
    res.json({ id: user._id, name: user.name, email: user.email, role: user.role });
  } catch {
    res.status(500).json({ error: AuthError.SERVER_ERROR });
  }
});

export default router;
