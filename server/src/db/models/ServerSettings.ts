import mongoose, { Schema, type InferSchemaType, type Model } from 'mongoose';

const serverSettingsSchema = new Schema(
  {
    enrollmentMode: {
      type: String,
      enum: ['open', 'locked'],
      default: 'locked',
    },
  },
  { timestamps: true },
);

export interface IServerSettingsModel extends Model<InferSchemaType<typeof serverSettingsSchema>> {}
export type ServerSettingsDoc = InferSchemaType<typeof serverSettingsSchema> & {
  _id: mongoose.Types.ObjectId;
};

export const ServerSettings = mongoose.model<InferSchemaType<typeof serverSettingsSchema>, IServerSettingsModel>(
  'ServerSettings',
  serverSettingsSchema,
);
