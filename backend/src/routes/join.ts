import { Router } from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { Interview, InterviewStatus } from '@ai-interview/db';
import { spawnAgent, isAgentRunning } from '../agent-manager';
import { JoinError } from '../constants/errors';

const router = Router();

// POST /join/:interviewId — generate a LiveKit token and ensure agent is running
router.post('/:interviewId', async (req, res) => {
  try {
    const interview = await Interview.findById(req.params.interviewId);
    if (!interview) return res.status(404).json({ error: JoinError.NOT_FOUND });
    if (interview.status === InterviewStatus.COMPLETED) return res.status(400).json({ error: JoinError.COMPLETED });
    if (interview.expiresAt < new Date()) return res.status(410).json({ error: JoinError.EXPIRED });

    // Re-spawn agent if backend restarted and agent is no longer running
    if (!isAgentRunning(interview._id.toString())) {
      spawnAgent(interview._id.toString(), interview.roomName);
    }

    const at = new AccessToken(
      process.env.LIVEKIT_API_KEY!,
      process.env.LIVEKIT_API_SECRET!,
      { identity: interview.candidateEmail },
    );
    at.addGrant({ roomJoin: true, room: interview.roomName, canPublish: true, canSubscribe: true });

    res.json({ token: await at.toJwt(), roomName: interview.roomName });
  } catch {
    res.status(500).json({ error: JoinError.SERVER_ERROR });
  }
});

export default router;
