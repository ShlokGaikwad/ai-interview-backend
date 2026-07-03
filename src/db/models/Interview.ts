import mongoose, { Schema, Document } from 'mongoose';
import { InterviewStatus } from '../enums';

export interface IInterview extends Document {
  jobRole: string;
  candidateEmail: string;
  status: InterviewStatus;
  caseStudyIds: string[];
  roomName: string;
  expiresAt: Date;
  startedAt?: Date;
  endedAt?: Date;
}

const InterviewSchema = new Schema<IInterview>(
  {
    jobRole: { type: String, required: true },
    candidateEmail: { type: String, required: true },
    status: { type: String, enum: Object.values(InterviewStatus), default: InterviewStatus.PENDING },
    caseStudyIds: [{ type: String }],
    roomName: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    startedAt: { type: Date },
    endedAt: { type: Date },
  },
  { timestamps: true },
);

export const Interview = mongoose.model<IInterview>('Interview', InterviewSchema);
