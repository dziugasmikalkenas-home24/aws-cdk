import * as sns from '@aws-cdk/aws-sns';
import { App, Stack } from '@aws-cdk/core';
import { NestedStack } from '../lib';

const app = new App();
const top = new Stack(app, 'nested-stacks-multi-refs');
const level1 = new sns.Topic(top, 'Level1');
const nested1 = new NestedStack(top, 'Nested1');
const nested2 = new NestedStack(nested1, 'Nested2');
const nested3 = new NestedStack(nested2, 'Nested3');

// WHEN
const level2 = new sns.Topic(nested2, 'Level2ReferencesLevel1', {
  displayName: level1.topicArn
});

new sns.Topic(nested3, 'Level3ReferencesLevel1', {
  displayName: level1.topicArn
});

new sns.Topic(nested3, 'Level3ReferencesLevel2', {
  displayName: level2.topicArn
});

app.synth();