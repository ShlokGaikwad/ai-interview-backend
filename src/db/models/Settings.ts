import mongoose, { Schema, Document } from 'mongoose';

interface IChangeEntry {
  updatedBy: mongoose.Types.ObjectId;
  updatedAt: Date;
  snapshot: string;
}

export interface ISettings extends Document {
  voiceInstructions: string;
  updatedAt: Date;
  changeHistory: IChangeEntry[];
}

const ChangeEntrySchema = new Schema<IChangeEntry>(
  {
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    updatedAt: { type: Date, required: true },
    snapshot: { type: String, required: true },
  },
  { _id: false },
);

const SettingsSchema = new Schema<ISettings>(
  {
    voiceInstructions: { type: String, required: true },
    changeHistory: { type: [ChangeEntrySchema], default: [] },
  },
  { timestamps: true },
);

export const Settings = mongoose.model<ISettings>('Settings', SettingsSchema);
