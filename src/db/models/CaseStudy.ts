import mongoose, { Schema, Document } from 'mongoose';

export interface ICaseStudy extends Document {
  slug: string;
  title: string;
  clientCode: string;
  jobRoles: string[];
  industryTags: string[];
  founderPersona: {
    background: string;
    tone: string;
  };
  businessContext: string;
  keyProblems: string[];
  interviewText: string;
}

const CaseStudySchema = new Schema<ICaseStudy>(
  {
    slug: { type: String, required: true, unique: true },
    title: { type: String, required: true },
    clientCode: { type: String, required: true },
    jobRoles: [{ type: String }],
    industryTags: [{ type: String }],
    founderPersona: {
      background: { type: String, required: true },
      tone: { type: String, required: true },
    },
    businessContext: { type: String, required: true },
    keyProblems: [{ type: String }],
    interviewText: { type: String, required: true },
  },
  { timestamps: true },
);

export const CaseStudy = mongoose.model<ICaseStudy>('CaseStudy', CaseStudySchema);
