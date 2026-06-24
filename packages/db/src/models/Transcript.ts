import mongoose, { Schema, Document } from 'mongoose';
import { Speaker } from '../enums';

export interface ITurn {
  turn: number;
  speaker: Speaker;
  text: string;
  timestamp: Date;
}

export interface ITranscript extends Document {
  interviewId: mongoose.Types.ObjectId;
  turns: ITurn[];
}

const TurnSchema = new Schema<ITurn>(
  {
    turn: { type: Number, required: true },
    speaker: { type: String, enum: Object.values(Speaker), required: true },
    text: { type: String, required: true },
    timestamp: { type: Date, default: Date.now },
  },
  { _id: false },
);

const TranscriptSchema = new Schema<ITranscript>(
  { interviewId: { type: Schema.Types.ObjectId, ref: 'Interview', required: true, unique: true } },
  { timestamps: true },
);

TranscriptSchema.add({ turns: { type: [TurnSchema], default: [] } });

export const Transcript = mongoose.model<ITranscript>('Transcript', TranscriptSchema);
