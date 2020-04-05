
import { CfnElement } from "../cfn-element";
import { Construct } from "../construct-compat";
import { IResolvable } from "../resolvable";
import { Stack } from "../stack";
import { CfnReference } from "./cfn-reference";
import { findTokens } from "./resolve";

export function prepareReferences(root: Construct) {
  let prepared: Set<string> = (root as any).$prepared;
  if (!prepared) {
    prepared = (root as any).$prepared = new Set<string>();
  }

  const stacks = root.node.findAll().filter(x => Stack.isStack(x)) as Stack[];

  for (const sourceStack of stacks) {
    const tokens = findTokensInStack(sourceStack);

    // References (originating from this stack)
    for (const reference of tokens) {

      // skip if this is not a CfnReference
      if (!CfnReference.isCfnReference(reference)) {
        continue;
      }

      const targetStack = Stack.of(reference.target);

      // skip if this is not a cross-stack reference
      if (targetStack === sourceStack) {
        continue;
      }

      const refid = JSON.stringify({
        source: sourceStack.node.path,
        target: reference.target.node.path,
        ref: reference.displayName
      });

      if (prepared.has(refid)) {
        continue; // already prepared, skipping
      } else {
        prepared.add(refid);
      }

      // determine which stack should create the cross reference
      const factory = determineCrossReferenceFactory(sourceStack, targetStack);

      // if one side is a nested stack (has "parentStack"), we let it create the reference
      // since it has more knowledge about the world.
      const consumedValue = (factory as any).prepareCrossReference(sourceStack, reference);

      // if the reference has already been assigned a value for the consuming stack, carry on.
      if (!reference.hasValueForStack(sourceStack)) {
        reference.assignValueForStack(sourceStack, consumedValue);
      }
    }
  }
}

/**
 * Returns all the tokens used within the scope of the current stack.
 */
function findTokensInStack(stack: Stack) {
  const tokens = new Array<IResolvable>();

  for (const element of CfnElement._findAll(stack)) {
    try {
      tokens.push(...findTokens(element, () => element._toCloudFormation()));
    }  catch (e) {
      // Note: it might be that the properties of the CFN object aren't valid.
      // This will usually be preventatively caught in a construct's validate()
      // and turned into a nicely descriptive error, but we're running prepare()
      // before validate(). Swallow errors that occur because the CFN layer
      // doesn't validate completely.
      //
      // This does make the assumption that the error will not be rectified,
      // but the error will be thrown later on anyway. If the error doesn't
      // get thrown down the line, we may miss references.
      if (e.type === 'CfnSynthesisError') {
        continue;
      }

      throw e;
    }
  }
  return tokens;
}

function determineCrossReferenceFactory(source: Stack, target: Stack) {
  // unsupported: stacks from different apps
  if (target.node.root !== source.node.root) {
    throw new Error(
      `Cannot reference across apps. ` +
      `Consuming and producing stacks must be defined within the same CDK app.`);
  }

  // unsupported: stacks are not in the same environment
  if (target.environment !== source.environment) {
    throw new Error(
      `Stack "${source.node.path}" cannot consume a cross reference from stack "${target.node.path}". ` +
      `Cross stack references are only supported for stacks deployed to the same environment or between nested stacks and their parent stack`);
  }

  // if one of the stacks is a nested stack, go ahead and give it the right to make the cross reference
  if (target.nested) { return target; }
  if (source.nested) { return source; }

  // both stacks are top-level (non-nested), the taret (producing stack) gets to make the reference
  return target;
}