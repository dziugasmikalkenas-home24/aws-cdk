
import { CfnElement } from "../cfn-element";
import { CfnOutput } from "../cfn-output";
import { CfnParameter } from "../cfn-parameter";
import { Construct } from "../construct-compat";
import { Reference } from "../reference";
import { IResolvable } from "../resolvable";
import { Stack } from "../stack";
import { Token } from "../token";
import { CfnReference } from "./cfn-reference";
import { Intrinsic } from './intrinsic';
import { findTokens } from "./resolve";
import { makeUniqueId } from "./uniqueid";

export function prepareReferences(root: Construct) {
  const refs = findAllReferences(root);

  for (const ref of refs) {
    const sourceStack = Stack.of(ref.source);
    const targetStack = Stack.of(ref.target);

    // skip if this is not a cross-stack reference
    if (targetStack === sourceStack) {
      return;
    }

    // if the reference has already been assigned a value for the consuming stack, carry on.
    if (!ref.reference.hasValueForStack(sourceStack)) {
      const consumedValue = prepareCrossReference(sourceStack, targetStack, ref.reference);
      ref.reference.assignValueForStack(sourceStack, consumedValue);
    }
  }
}

interface Ref {
  readonly refid: string;
  readonly source: CfnElement;
  readonly target: Construct;
  readonly reference: CfnReference;
}

function prepareCrossReference(sourceStack: Stack, targetStack: Stack, reference: Reference) {
  // unsupported: stacks from different apps
  if (targetStack.node.root !== sourceStack.node.root) {
    throw new Error(
      `Cannot reference across apps. ` +
      `Consuming and producing stacks must be defined within the same CDK app.`);
  }

  // unsupported: stacks are not in the same environment
  if (targetStack.environment !== sourceStack.environment) {
    throw new Error(
      `Stack "${sourceStack.node.path}" cannot consume a cross reference from stack "${targetStack.node.path}". ` +
      `Cross stack references are only supported for stacks deployed to the same environment or between nested stacks and their parent stack`);
  }

  // if one of the stacks is a nested stack, go ahead and give it the right to make the cross reference
  if (targetStack.nested) {
    return prepareCrossReferenceNested(targetStack, sourceStack, reference);
  } else if (sourceStack.nested) {
    return prepareCrossReferenceNested(sourceStack, sourceStack, reference);
  } else {
    return prepareCrossReferenceNonNested(sourceStack, reference);
  }
}

/**
 * Returns all the tokens used within the scope of the current stack.
 */
function findAllReferences(root: Construct) {
  const result = new Array<Ref>();
  for (const source of root.node.findAll()) {
    if (!CfnElement.isCfnElement(source)) {
      continue;
    }

    try {
      const tokens = findTokens(source, () => source._toCloudFormation());
      for (const token of tokens) {
        if (CfnReference.isCfnReference(token)) {
          const refid = JSON.stringify({
            source: source.node.path,
            target: token.target.node.path,
            ref: token.displayName
          });

          if (!(token.target instanceof Construct)) {
            throw new Error(`objects that implement IConstruct must extend "Construct"`);
          }

          result.push({
            refid,
            target: token.target,
            source,
            reference: token
          });
        }
      }
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

  return result;
}

/**
 * Exports a resolvable value for use in another stack.
 *
 * @returns a token that can be used to reference the value from the producing stack.
 */
function prepareCrossReferenceNonNested(sourceStack: Stack, reference: Reference): IResolvable {
  const targetStack = Stack.of(reference.target);

  // Ensure a singleton "Exports" scoping Construct
  // This mostly exists to trigger LogicalID munging, which would be
  // disabled if we parented constructs directly under Stack.
  // Also it nicely prevents likely construct name clashes
  const exportsScope = getCreateExportsScope(targetStack);

  // Ensure a singleton CfnOutput for this value
  const resolved = targetStack.resolve(reference);
  const id = 'Output' + JSON.stringify(resolved);
  const exportName = generateExportName(exportsScope, id);
  const output = exportsScope.node.tryFindChild(id) as CfnOutput;
  if (!output) {
    new CfnOutput(exportsScope, id, { value: Token.asString(reference), exportName });
  }

  // add a dependency on the producing stack - it has to be deployed before this stack can consume the exported value
  // if the producing stack is a nested stack (i.e. has a parent), the dependency is taken on the parent.
  const producerDependency = targetStack.nestedStackParent ? targetStack.nestedStackParent : targetStack;
  const consumerDependency = sourceStack.nestedStackParent ? sourceStack.nestedStackParent : sourceStack;
  consumerDependency.addDependency(producerDependency, `${sourceStack.node.path} -> ${reference.target.node.path}.${reference.displayName}`);

  // We want to return an actual FnImportValue Token here, but Fn.importValue() returns a 'string',
  // so construct one in-place.
  return new Intrinsic({ 'Fn::ImportValue': exportName });
}

function getCreateExportsScope(stack: Stack) {
  const exportsName = 'Exports';
  let stackExports = stack.node.tryFindChild(exportsName) as Construct;
  if (stackExports === undefined) {
    stackExports = new Construct(stack, exportsName);
  }

  return stackExports;
}

function generateExportName(stackExports: Construct, id: string) {
  const stack = Stack.of(stackExports);
  const components = [...stackExports.node.scopes.slice(2).map(c => c.node.id), id];
  const prefix = stack.stackName ? stack.stackName + ':' : '';
  const exportName = prefix + makeUniqueId(components);
  return exportName;
}

//////////////////////////////////////
// NESTED STACKS
//////////////////////////////////////

/**
 * Called by the base "prepare" method when a reference is found.
 */
function prepareCrossReferenceNested(nested: Stack, sourceStack: Stack, reference: Reference): IResolvable {
  const targetStack = Stack.of(reference.target);

  if (!nested.nestedStackResource) {
    throw new Error(`assertion failed: nested stacks must have a "nestedStackResource"`);
  }

  if (nested.nestedStackResource.cfnResourceType !== 'AWS::CloudFormation::Stack') {
    throw new Error(`assertion failed: nested stack resource must be an AWS::CloudFormation::Stack resource`);
  }

  // the nested stack references a resource from the parent stack (directly or indirectly):
  // we add a parameter to our stack and assign it the value of the reference from the parent.
  // if the source is not directly from the parent, this logic will also happen at the parent level (recursively).
  if (sourceStack.nestedStackParent && isParentOfNestedStack(targetStack, sourceStack)) {
    // we call "this.resolve" to ensure that tokens do not creep in (for example, if the reference display name includes tokens)
    const paramId = nested.resolve(`reference-to-${reference.target.node.uniqueId}.${reference.displayName}`);
    let param = nested.node.tryFindChild(paramId) as CfnParameter;
    if (!param) {
      param = new CfnParameter(nested, paramId, { type: 'String' });

      // Ugly little hack until we move NestedStack to this module.
      if (!('setParameter' in nested)) {
        throw new Error(`assertion failed: nested stack should have a "setParameter" method`);
      }

      (nested as any).setParameter(param.logicalId, Token.asString(reference));
    }

    return param.value;
  }

  // parent stack references a resource from the nested stack:
  // we output it from the nested stack and use "Fn::GetAtt" as the reference value
  if (targetStack === nested && targetStack.nestedStackParent === sourceStack) {
    return getCreateOutputForReference(nested, reference);
  }

  // sibling nested stacks (same parent):
  // output from one and pass as parameter to the other
  if (targetStack.nestedStackParent && targetStack.nestedStackParent === sourceStack.nestedStackParent) {
    const outputValue = getCreateOutputForReference(nested, reference);
    return prepareCrossReferenceNested(sourceStack, sourceStack, outputValue);
  }

  // nested stack references a value from some other non-nested stack:
  // normal export/import, with dependency between the parents
  if (sourceStack.nestedStackParent && sourceStack.nestedStackParent !== targetStack) {
    return prepareCrossReferenceNonNested(sourceStack, reference);
  }

  // some non-nested stack (that is not the parent) references a resource inside the nested stack:
  // we output the value and let our parent export it
  if (!sourceStack.nestedStackParent && targetStack.nestedStackParent && targetStack.nestedStackParent !== sourceStack) {
    const outputValue = getCreateOutputForReference(nested, reference);
    return prepareCrossReference(sourceStack, targetStack.nestedStackParent, outputValue);
  }

  throw new Error('unexpected nested stack cross reference');
}

function getCreateOutputForReference(nested: Stack, reference: Reference) {
  const outputId = `${reference.target.node.uniqueId}${reference.displayName}`;
  let output = nested.node.tryFindChild(outputId) as CfnOutput;
  if (!output) {
    output = new CfnOutput(nested, outputId, { value: Token.asString(reference) });
  }

  if (!nested.nestedStackResource) {
    throw new Error('assertion failed');
  }

  return nested.nestedStackResource.getAtt(`Outputs.${output.logicalId}`);
}

/**
 * @returns true if this stack is a direct or indirect parent of the nested
 * stack `nested`. If `nested` is a top-level stack, returns false.
 */
export function isParentOfNestedStack(parent: Stack, child: Stack): boolean {
  // if "nested" is not a nested stack, then by definition we cannot be its parent
  if (!child.nestedStackParent) {
    return false;
  }

  // if this is the direct parent, then we found it
  if (parent === child.nestedStackParent) {
    return true;
  }

  // traverse up
  return isParentOfNestedStack(parent, child.nestedStackParent);
}
