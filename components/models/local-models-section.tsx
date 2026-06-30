'use client';

import {useState} from 'react';
import type {Model} from '@/lib/models';
import {ModelList} from '@/components/models/model-list';

export function LocalModelsSection({initialModels}: {initialModels: Model[]}) {
  const [models] = useState(initialModels);
  return <ModelList models={models} />;
}
