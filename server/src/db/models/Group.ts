import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const groupSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      maxlength: 64,
    },
    description: {
      type: String,
      default: '',
      maxlength: 500,
    },
  },
  { timestamps: true },
);

export interface IGroupModel extends Model<InferSchemaType<typeof groupSchema>> {}
export type GroupDoc = InferSchemaType<typeof groupSchema> & { _id: mongoose.Types.ObjectId };

export const Group = mongoose.model<InferSchemaType<typeof groupSchema>, IGroupModel>('Group', groupSchema);
