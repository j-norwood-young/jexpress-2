process.env.NODE_ENV = 'test';
const path = require("path");

const model_dir = path.join(process.cwd(), "./models");

global.JXPSchema = require("../libs/schema");

const User = require(path.join(model_dir, "user_model"));
const Apikey = require(path.join(model_dir, "apikey_model"));
const Test = require(path.join(model_dir, "test_model"));

const security = require("../libs/security");

const chai = require('chai');
const chaiHttp = require('chai-http');
const should = chai.should();

const server = require(path.join(__dirname, "../bin/server.js"));

chai.use(chaiHttp);

const empty = async model => {
	try {
		const result = await model.deleteMany({});
	} catch(err) {
		console.error(err);
		throw(err);
	}
};

const post = (model, data) => {
	return new Promise((resolve, reject) => {
		const item = new model(data);
		item.save((err, result) => {
			if (err)
				return reject(err);
			return resolve(result);
		});
	});
};

const email = "test@freespeechpub.co.za";
const password = "test";
const admin_email = "admin@freespeechpub.co.za";
const admin_password = "SecretPassword";

const init = async () => {
	try {
		await empty_user_collections();
		await post(User, { name: "Admin User", email: admin_email, password: security.encPassword(admin_password), urlid: "admin-user", admin: true });
		await post(User, { name: "Test User", email, password: security.encPassword(password), urlid: "test-user" });
		return true;
	} catch(err) {
		console.error(err);
		throw(err);
	}
};

const empty_user_collections = async () => {
	try {
		await empty(User);
		await empty(Apikey);
		await empty(Test);
	} catch(err) {
		console.error(err);
		throw(err);
	}
}

// describe('Init', () => {
// 	beforeEach(() => {
// 		return init();
// 	});

// 	describe("/GET user", () => {
// 		it("it should GET all the users", (done) => {
// 			chai.request(server)
// 			.get("/api/user")
// 			.auth(email, password)
// 			.end((err, res) => {
// 				res.should.have.status(200);
// 				res.body.data.should.be.a('array');
// 				res.body.data.length.should.be.eql(2);
// 				done();
// 			});
// 		});
// 	});

// });

module.exports = {
	init,
	empty_user_collections,
	email,
	password,
	admin_email,
	admin_password,
};
