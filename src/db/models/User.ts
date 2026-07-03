import mongoose, { Schema, Document } from 'mongoose';
import { UserRole } from '../enums';

export interface IUser extends Document {
  name: string;
  email: string;
  password: string;
  role: UserRole;
}

const UserSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password: { type: String, required: true },
    role: { type: String, enum: Object.values(UserRole), default: UserRole.ADMIN },
  },
  { timestamps: true },
);

export const User = mongoose.model<IUser>('User', UserSchema);
