import EmberObject from '@ember/object';
import { module, test } from 'qunit';
import { setupRenderingTest } from 'ember-qunit';
import { timeout } from 'ember-concurrency';
import { render, click, waitFor } from '@ember/test-helpers';
import hbs from 'htmlbars-inline-precompile';
import DS from 'ember-data';

let model;

module('Integration | Component | cs version control', function(hooks) {
  setupRenderingTest(hooks);

  hooks.beforeEach(function() {
    // We need a valid model here because the component will go
    // looking for its metadata, and ember-resource-metadata works
    // through ember-data's identity map.
    this.owner.register('model:thing', DS.Model.extend());
    model = EmberObject.create({
      id: 1,
      type: 'thing',
      serialize() {
        return {
          id: '1',
          type: 'things',
          data: {
            attributes: {}
          }
        }
      }
    });
    this.set('model', model);
    this.meta = this.owner.lookup('service:resource-metadata');
    this.get('meta').write(model, { branch: 'master' });
    this.owner.register('config:enviroment', {
      cardstack: { defaultBranch: 'master' }
    });
    this.owner.lookup('router:main').setupRouter();
  });

  test('render with saved content', async function(assert) {
    model.set('hasDirtyFields', false);
    model.set('isNew', false);
    await render(hbs`{{cs-version-control model=model enabled=true}}`);
    assert.dom('[data-test-cs-version-control-button-save="true"]').hasText('Save');
  });

  test('render with dirty content', async function(assert) {
    model.set('hasDirtyFields', true);
    model.set('isNew', false);
    await render(hbs`{{cs-version-control model=model enabled=true}}`);
    assert.dom('[data-test-cs-version-control-button-save="true"]').doesNotExist('no disabled button');
    assert.dom('[data-test-cs-version-control-button-save="false"]').hasText('Save');
  });

  test('clicking update on dirty model triggers save', async function(assert) {
    assert.expect(1);
    model.set('save', function() {
      assert.ok(true);
    });
    model.set('hasDirtyFields', true);
    model.set('isNew', false);
    await render(hbs`{{cs-version-control model=model enabled=true}}`);
    await click('[data-test-cs-version-control-button-save="false"]');
  });

  test('clicking update shows loading spinner', async function(assert) {
    assert.expect(2);
    model.set('save', async () => await timeout(5));
    model.set('hasDirtyFields', true);
    model.set('isNew', false);
    assert.dom('[data-test-cs-version-control-loading]').doesNotExist('Does not display loading before click');
    await render(hbs`{{cs-version-control model=model enabled=true}}`);
    click('[data-test-cs-version-control-button-save="false"]');
    await waitFor('[data-test-cs-version-control-loading]');
    assert.dom('[data-test-cs-version-control-loading]').exists('Displays loading after click');
  });

  test('clicking update on clean model does nothing', async function(assert) {
    assert.expect(0);
    model.set('save', function() {
      throw new Error("should not happen");
    });
    model.set('hasDirtyFields', false);
    model.set('isNew', false);
    await render(hbs`{{cs-version-control model=model enabled=true}}`);
    await click('[data-test-cs-version-control-button-save="true"]');
  });

  test('clicking delete triggers deleteRecord', async function(assert) {
    assert.expect(1);
    model.set('destroyRecord', function() {
      assert.ok(true);
    });
    model.set('isNew', false);
    await render(hbs`{{cs-version-control model=model enabled=true}}`);
    await click('[data-test-cs-version-control-delete-button]');
  });

  test('"draft" status is displayed for new model', async function (assert) {
    model.set('isNew', true);
    await render(hbs`{{cs-version-control model=model enabled=true}}`);
    assert.dom('[data-test-cs-version-control-dropdown-option-status]').hasText('draft');
  });

  test('"published" status is displayed for clean model', async function (assert) {
    model.set('hasDirtyFields', false);
    model.set('isNew', false);
    await render(hbs`{{cs-version-control model=model enabled=true}}`);
    assert.dom('[data-test-cs-version-control-dropdown-option-status]').hasText('published');
  });

  test('"edited" status is displayed for dirty model', async function (assert) {
    model.set('hasDirtyFields', true);
    model.set('isNew', false);
    await render(hbs`{{cs-version-control model=model enabled=true}}`);
    assert.dom('[data-test-cs-version-control-dropdown-option-status]').hasText('edited');
  });
});
