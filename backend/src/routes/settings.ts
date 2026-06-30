import { Router } from 'express';
import { Settings } from '@ai-interview/db';

const router = Router();

// GET /settings/prompt — return current voice instructions
router.get('/prompt', async (req, res) => {
  try {
    const settings = await Settings.findOne().lean();
    res.json({ voiceInstructions: settings?.voiceInstructions ?? null });
  } catch {
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /settings/prompt — update voice instructions, push old value to changeHistory
router.put('/prompt', async (req, res) => {
  try {
    const { voiceInstructions } = req.body;
    if (!voiceInstructions || typeof voiceInstructions !== 'string') {
      return res.status(400).json({ error: 'voiceInstructions is required' });
    }

    const existing = await Settings.findOne();

    if (!existing) {
      const created = await Settings.create({
        voiceInstructions,
        changeHistory: [],
      });
      return res.json({ voiceInstructions: created.voiceInstructions });
    }

    existing.changeHistory.push({
      updatedBy: req.user!.userId as any,
      updatedAt: new Date(),
      snapshot: existing.voiceInstructions,
    });
    existing.voiceInstructions = voiceInstructions;
    await existing.save();

    res.json({ voiceInstructions: existing.voiceInstructions });
  } catch {
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

export default router;
