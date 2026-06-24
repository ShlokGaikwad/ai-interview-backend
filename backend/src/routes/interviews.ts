import { Router } from "express";
import { Interview, CaseStudy } from "@ai-interview/db";
import { nanoid } from "nanoid";
import { InterviewError } from "../constants/errors";

const router = Router();

// POST /interviews — create a new interview session and spawn the agent
router.post("/", async (req, res) => {
  try {
    const { jobRole, candidateEmail, caseStudyId } = req.body;
    if (!jobRole || !candidateEmail) {
      return res.status(400).json({ error: InterviewError.MISSING_FIELDS });
    }

    // Resolve case study: use provided ID or pick one at random matching jobRole
    let resolvedCaseStudyId = caseStudyId;
    if (!resolvedCaseStudyId) {
      const [cs] = await CaseStudy.aggregate([
        { $match: { jobRoles: jobRole } },
        { $sample: { size: 1 } },
        { $project: { _id: 1 } },
      ]);
      if (cs) resolvedCaseStudyId = cs._id.toString();
    }

    const roomName = `interview-${nanoid(10)}`;
    const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000); // 3 days
    const interview = await Interview.create({
      jobRole,
      candidateEmail,
      roomName,
      status: "pending",
      caseStudyIds: resolvedCaseStudyId ? [resolvedCaseStudyId] : [],
      expiresAt,
    });

    res.status(201).json(interview);
  } catch {
    res.status(500).json({ error: InterviewError.SERVER_ERROR });
  }
});

// GET /interviews/:id — get interview details
router.get("/:id", async (req, res) => {
  try {
    const interview = await Interview.findById(req.params.id);
    if (!interview) return res.status(404).json({ error: "Not found" });
    res.json(interview);
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch interview" });
  }
});

export default router;
